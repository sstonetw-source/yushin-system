/* Recipient cards and durable browser jobs call the existing warehouse writers. */
(function(root){
  'use strict';
  let groups=[],editing=null,notice='',visibleLimit=50;
  const active=new Set();
  const el=id=>document.getElementById(id);
  const escapeAttr=value=>String(value??'').replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  function actor(){
    if(!canReceiveInventoryCapability()||!canAccessPage('inventory')||!currentUser?.uid)throw Error('目前沒有倉庫寄貨權限。');
    return {uid:currentUser.uid,role:currentUserRole,project:firebase.app().options.projectId};
  }
  function storageKey(a){return 'warehouse-parcels:'+JSON.stringify([a.project,a.uid,a.role]);}
  function same(a){try{return storageKey(actor())===storageKey(a);}catch(_){return false;}}
  function read(a){
    const raw=localStorage.getItem(storageKey(a));
    if(!raw)return [];
    const tasks=JSON.parse(raw);
    if(!Array.isArray(tasks)||tasks.some(t=>!t.id||!Array.isArray(t.jobs)||!t.jobs.length||t.actor?.uid!==a.uid||t.actor?.role!==a.role||t.actor?.project!==a.project))throw Error('寄貨進度無法讀取，請保留原瀏覽器資料並聯絡管理員。');
    return tasks;
  }
  function lock(name,fn){
    if(!navigator.locks?.request)throw Error('請使用支援背景寄貨的新版瀏覽器。');
    return navigator.locks.request(name,fn);
  }
  function update(a,id,fn){
    return lock(storageKey(a)+':save',()=>{
      const tasks=read(a),index=tasks.findIndex(t=>t.id===id);
      const result=fn(index<0?null:tasks[index],tasks);
      if(result===null){if(index>=0)tasks.splice(index,1);}
      else if(index<0)tasks.push(result);else tasks[index]=result;
      localStorage.setItem(storageKey(a),JSON.stringify(tasks));
      return result;
    });
  }
  function rowId(job){return job.row.order.id+'__'+job.row.item.itemId;}
  function blocked(list,tasks){return tasks.some(t=>t.jobs.some(j=>list.some(r=>rowId(j)===r.order.id+'__'+r.item.itemId)));}
  function groupRows(rows){
    const api=root.YushinWarehouseLogistics,map=new Map(),main=defaultWarehouse()?.id||'';
    for(const row of rows){
      const p=api.executionPlan(row,warehouseMasterCache,main),key=api.bundleKey(row,p);
      if(!map.has(key))map.set(key,{key,plan:p,warehouseId:row.warehouseId,rows:[]});
      map.get(key).rows.push(row);
    }
    return [...map.values()];
  }
  function taskCards(tasks){
    return tasks.map(t=>'<article class="parcel-card parcel-task"><strong>'+escapeHtml(t.plan.contact)+'</strong><p role="status">'+
      (active.has(t.id)?'寄出中…':escapeHtml(t.error||'上次寄貨尚未確認，請核對原操作。'))+'</p><p>已確認 '+t.jobs.filter(j=>j.done).length+'／'+t.jobs.length+' 個品項</p>'+
      '<details><summary>本次寄貨明細</summary><p>'+escapeHtml(t.date)+' · '+escapeHtml(t.notes||'')+'</p>'+t.jobs.map(j=>'<p>'+escapeHtml(j.row.item.itemCode)+' × '+j.qty+' · '+(j.done?'已確認':'待核對')+'</p>').join('')+'</details>'+
      (active.has(t.id)?'':'<button type="button" class="btn-secondary" onclick="resumeWarehouseParcel('+inlineJsValue(t.id)+')">核對／重試原寄貨</button>')+'</article>').join('');
  }
  root.renderWarehouseParcels=function(){
    const host=el('warehouseParcelCards'),status=el('warehouseParcelStatus');
    if(!host)return;
    try{
      const a=actor(),tasks=read(a);
      let rows=root.warehouseParcelSourceRows?.()||[];
      const kind=root.inventoryShippingActiveKind?.(),mainId=defaultWarehouse()?.id||'';
      const inScope=id=>kind==='main'?id===mainId:kind==='branch'?!!id&&id!==mainId:true;
      rows=rows.filter(row=>inScope(row.warehouseId));
      groups=groupRows(rows).filter(g=>!blocked(g.rows,tasks));
      const scopedTasks=tasks.filter(t=>t.jobs.some(j=>inScope(j.row.warehouseId)));
      const transfers=kind==='branch'?root.mainTransferParcelEntries?.():null;
      const transferRows=(transfers?.entries||[]).filter(r=>inScope(r.warehouseId));
      const transferCards=transferRows.map(r=>{
        const p=r.recipient,wh=warehouseMasterCache.find(w=>w.id===r.warehouseId);
        const complete=p.contact&&p.phone&&p.address&&p.warehouseId;
        const keyArgs=inlineJsValue(r.kind)+','+inlineJsValue(r.id)+','+inlineJsValue(r.itemId||'');
        const dispatch=r.kind==='order'?`startOrderWarehouseTransfer(${inlineJsValue(r.id)},${inlineJsValue(r.itemId)},this)`:
          `dispatchMainTransferRequest(${inlineJsValue(r.id)},this)`;
        return '<article class="parcel-card parcel-simple-card" data-shipping-warehouse="'+escapeAttr(r.warehouseId)+'" data-transfer-kind="'+escapeAttr(r.kind)+'" data-transfer-id="'+escapeAttr(r.id)+'"><div class="parcel-destination"><span class="parcel-field-caption">寄給誰／寄到哪裡</span><h3>'+escapeHtml(p.contact||'主倉收件資料待補')+'</h3><p class="parcel-address">'+escapeHtml(p.address||'主倉尚未設定收件地址')+'</p><p class="parcel-recipient-phone">'+escapeHtml(p.phone||'電話待補')+'</p></div>'+
          '<div class="parcel-contents"><strong class="parcel-field-caption">要寄的貨品</strong><ul class="parcel-items"><li><span>'+escapeHtml(r.itemCode)+'　'+escapeHtml(r.itemName)+'</span><strong>× '+r.qty+'</strong></li></ul></div>'+
          '<details class="parcel-extra-details"><summary>更多資訊</summary><p>來源：'+escapeHtml(wh?.warehouseName||r.warehouseId)+'</p><p>單據：'+escapeHtml(r.source)+'</p><p>電話：'+escapeHtml(p.phone||'待補')+'</p>'+
          (r.kind==='stock'&&canManageInventoryStockPolicy()&&canEditPage('inventory')?'<button type="button" class="btn-danger" onclick="cancelMainTransferRequest('+inlineJsValue(r.id)+',this)">取消尚未寄出的備貨需求</button>':'')+'</details>'+
          (!r.ready?'<p class="parcel-guard-note" role="status">貨品尚未全部到齊並打單，暫不能寄出。</p>':'')+
          (!complete?'<p class="parcel-guard-note" role="status">主倉收件資料未完整，請管理員在倉庫設定補齊。</p>':'')+
          '<div class="parcel-actions"><button type="button" class="btn-secondary" onclick="printMainTransferParcel('+keyArgs+',this)" '+(complete?'':'disabled')+'>列印貼紙</button><button type="button" onclick="'+dispatch+'" '+(complete&&r.ready?'':'disabled')+'>確認寄出</button></div></article>';
      }).join('');
      const recoveryCards=(transfers?.recoveries||[]).map(r=>{
        const action=r.kind==='request'?`resumeMainTransferOperation(${inlineJsValue(r.id)},this)`:
          r.kind==='physical'?`resumeMainTransferPhysical('DISPATCH',${inlineJsValue(r.id)},this)`:
          `resumeOrderTransferOperation(${inlineJsValue(r.action)},${inlineJsValue(r.id)},this)`;
        return '<article class="parcel-card parcel-task"><strong>前次寄貨／調撥操作待核對</strong><p role="status">'+escapeHtml(r.detail)+'</p><button type="button" class="btn-secondary" onclick="'+action+'">核對原操作</button></article>';
      }).join('');
      host.innerHTML=taskCards(scopedTasks)+recoveryCards+groups.slice(0,visibleLimit).map((g,index)=>{
        const p=g.plan,wh=warehouseMasterCache.find(w=>w.id===g.warehouseId);
        const complete=p.contact&&p.phone&&p.address;
        const items=root.YushinWarehouseLogistics.aggregateRows(g.rows);
        return '<article class="parcel-card parcel-simple-card" data-shipping-warehouse="'+escapeAttr(g.warehouseId)+'" data-order-ids="'+escapeAttr(g.rows.map(r=>r.order.id).join(','))+'"><div class="parcel-destination"><span class="parcel-field-caption">寄給誰／寄到哪裡</span><h3>'+escapeHtml(p.contact||'待補收件人')+'</h3><p class="parcel-address">'+escapeHtml(p.address||'尚未填寫收件地址')+'</p><p class="parcel-recipient-phone">'+escapeHtml(p.phone||'電話待補')+'</p></div>'+
          '<div class="parcel-contents"><strong class="parcel-field-caption">要寄的貨品</strong><ul class="parcel-items">'+items.map(item=>'<li><span>'+escapeHtml(item.item.itemCode)+'　'+escapeHtml(item.item.itemName)+'</span><strong>× '+item.qty+'</strong></li>').join('')+'</ul></div>'+
          '<details class="parcel-extra-details"><summary>更多資訊／修改收件資料</summary><p>來源：'+escapeHtml(wh?.warehouseName||g.warehouseId)+'</p><p>寄送方式：'+escapeHtml(root.YushinWarehouseLogistics.modes[p.mode])+'</p><p>電話：'+escapeHtml(p.phone||'待補')+'</p>'+g.rows.map(r=>'<p>'+escapeHtml(r.order.orderNo||r.order.quoteNo||'來源訂單')+' · '+escapeHtml(r.order.customerName||'')+' · '+escapeHtml(r.order.salesName||'')+'</p><button type="button" class="btn-secondary" onclick="openWarehouseDeliveryPlan('+inlineJsValue(r.order.id)+','+inlineJsValue(r.item.itemId)+')">編輯收件資料</button>').join('')+'<p>'+escapeHtml(p.notes)+'</p></details>'+
          '<div class="parcel-actions">'+(complete?'<button type="button" class="btn-secondary" onclick="printWarehouseParcel('+index+',this)">列印貼紙</button><button type="button" onclick="openWarehouseParcel('+index+',this)">確認寄出</button>':
          '<button type="button" onclick="openWarehouseDeliveryPlan('+inlineJsValue(g.rows[0].order.id)+','+inlineJsValue(g.rows[0].item.itemId)+')">補收件資料</button>')+'</div></article>';
      }).join('')+transferCards+(groups.length>visibleLimit?'<button type="button" class="btn-secondary" onclick="loadMoreWarehouseParcels()">載入更多寄貨</button>':'')+
        (transfers?.error?'<p class="parcel-guard-note" role="alert">調撥資料讀取失敗：'+escapeHtml(transfers.error)+' <button type="button" onclick="loadMainTransferRequests(true)">重新載入</button></p>':'')+
        (transfers?.hasMore?'<p class="parcel-guard-note">備貨需求先顯示 50 筆，處理後會載入後續項目。</p>':'')+
        (!groups.length&&!transferRows.length&&!scopedTasks.length&&!recoveryCards&&orderWorkQueueReady&&!orderWorkQueueError&&(!transfers||transfers.ready&&!transfers.error)?'<p class="parcel-empty-state">目前沒有需要寄出的貨品。</p>':'');
      if(status)status.textContent=notice||(orderWorkQueueError?'寄貨清單讀取失敗，請重新載入。':!orderWorkQueueReady||transfers&&!transfers.ready?'正在讀取寄貨資料…':(groups.length+transferRows.length)+' 件待寄貨'+(tasks.length?' · '+tasks.length+' 件處理中／待核對':'')+(groups.length>visibleLimit?'，已顯示部分品項。':''));
    }catch(error){
      host.innerHTML='<p role="alert">'+escapeHtml(error.message)+'</p>';
    }
  };
  root.loadMoreWarehouseParcels=function(){visibleLimit+=50;root.renderWarehouseParcels();};
  async function freshGroup(index){
    const a=actor(),group=groups[index];if(!group)throw Error('清單已更新，請重新選擇收件人。');
    const keys=group.rows.map(r=>r.key);
    await loadOrderWorkQueue(true);
    if(!same(a))throw Error('登入身分已變更。');
    if(!orderWorkQueueReady||orderWorkQueueError)throw Error('寄貨清單尚未確認，請重新載入。');
    const rows=(root.warehouseParcelSourceRows()||[]).filter(r=>keys.includes(r.key));
    const next=groupRows(rows);
    if(rows.length!==keys.length||next.length!==1||next[0].key!==group.key)throw Error('品項或收件資料已變更，請重新核對。');
    return next[0];
  }
  root.printWarehouseParcel=async function(index,button){
    const state=beginActionButton(button,'核對中…');
    try{
      const group=await freshGroup(index);
      root.printWarehouseAddressGroups([group]);
    }catch(error){showActionFeedback(error.message,'warning');}
    finally{endActionButton(button,state);}
  };
  root.hasWarehouseParcelWork=()=>read(actor()).length>0;
  root.openWarehouseParcel=async function(index,button){
    const state=beginActionButton(button,'核對中…');
    try{
      if(root.warehouseLegacyBatchActive?.())throw Error('請先關閉進階批次操作，再確認寄貨。');
      notice='';
      const a=actor(),group=await freshGroup(index);
      if(blocked(group.rows,read(a)))throw Error('此品項已有未完成寄貨，請先核對原操作。');
      const jobs=root.prepareWarehouseParcelJobs(group.rows);
      editing={id:lifecycleRecordId(),actor:a,plan:group.plan,jobs,date:localDateString(),notes:'',error:''};
      let dialog=el('warehouseParcelDialog');
      if(!dialog){dialog=document.createElement('dialog');dialog.id='warehouseParcelDialog';dialog.className='parcel-dialog';document.body.append(dialog);}
      dialog.innerHTML='<h3>確認寄出給 '+escapeHtml(group.plan.contact)+'</h3><p>'+escapeHtml(group.plan.address)+'</p>'+
        '<label>寄出日期<input id="parcelDate" type="date" value="'+editing.date+'"></label>'+
        '<div class="parcel-confirm-items">'+jobs.map((j,i)=>'<label><span>'+escapeHtml(j.row.item.itemCode)+' '+escapeHtml(j.row.item.itemName)+'</span><input aria-label="本次寄出數量（填 0 表示這次不寄）" data-parcel-quantity="'+i+'" type="number" min="0" step="any" max="'+j.qty+'" value="'+j.qty+'" '+(j.priorShipment?'readonly':'')+'></label>').join('')+'</div>'+
        '<label>寄貨備註<input id="parcelNotes" maxlength="500"></label><p>本頁會在背景處理；關頁或手機暫停後，請回來核對原寄貨。</p><p id="parcelConfirmError" role="alert"></p><div class="parcel-actions"><button type="button" class="btn-secondary" onclick="document.getElementById(\'warehouseParcelDialog\').close()">返回</button><button type="button" onclick="confirmWarehouseParcel(this)">確認寄出</button></div>';
      dialog.showModal();
    }catch(error){showActionFeedback(error.message,'warning');}
    finally{endActionButton(button,state);}
  };
  root.confirmWarehouseParcel=async function(button){
    const task=editing;if(!task||!same(task.actor)||button.disabled)return;
    button.disabled=true;
    try{
      task.date=el('parcelDate').value;task.notes=el('parcelNotes').value.trim();
      if(!/^\d{4}-\d{2}-\d{2}$/.test(task.date)||new Date(task.date+'T00:00:00Z').toISOString().slice(0,10)!==task.date)throw Error('請核對寄出日期。');
      document.querySelectorAll('[data-parcel-quantity]').forEach(input=>{
        const job=task.jobs[Number(input.dataset.parcelQuantity)],qty=Number(input.value);
        if(!Number.isFinite(qty)||qty<0||qty>job.row.qty||(job.priorShipment&&qty!==job.qty)||(job.plan.mode!=='CUSTOMER_SHIP'&&qty!==0&&qty!==job.qty))throw Error('請核對本次寄出數量；不寄的品項可填 0。');
        job.qty=qty;
      });
      task.jobs=task.jobs.filter(job=>job.qty>0);
      if(!task.jobs.length)throw Error('請至少選擇一項要寄出的商品。');
      // Persist only the frozen operation inputs, never product costs or full order data.
      const stored={...task,jobs:task.jobs.map(j=>({...j,row:{key:j.row.key,warehouseId:j.row.warehouseId,
        order:{id:j.row.order.id},item:{itemId:j.row.item.itemId,itemCode:j.row.item.itemCode}}}))};
      await update(task.actor,task.id,(_previous,tasks)=>{
        if(!same(task.actor))throw Error('登入身分已變更。');
        if(blocked(task.jobs.map(j=>j.row),tasks))throw Error('此品項已在另一筆寄貨中，請核對清單。');
        return stored;
      });
      if(editing===task){editing=null;el('warehouseParcelDialog').close();}
      root.renderWarehouseParcels();
      void run(task.actor,task.id);
    }catch(error){if(editing===task)el('parcelConfirmError').textContent=error.message;}
    finally{button.disabled=false;}
  };
  async function run(a,id){
    if(active.has(id))return;
    active.add(id);
    root.renderWarehouseParcels();
    try{
      await lock(storageKey(a)+':task:'+id,async()=>{
        const task=read(a).find(t=>t.id===id);if(!task)return;
        for(const job of task.jobs){
          if(job.done)continue;
          if(!same(a))throw Error('登入身分已變更，請用原帳號核對寄貨。');
          await root.commitWarehouseParcelJob(job,task.date,task.notes);
          job.done=true;job.error='';task.error='';
          await update(a,id,()=>task);
          if(same(a))root.renderWarehouseParcels();
        }
        // A successful server write stays completed even if refreshing the list fails.
        if(same(a)){
          await refreshAffectedOrderCaches([...new Set(task.jobs.map(j=>j.row.order.id))]);
          await loadOrderWorkQueue(true);
          await loadInventory(true);
          if(!same(a))throw Error('登入身分已變更。');
        }
        await update(a,id,()=>null);
        if(same(a)){notice='已確認寄出給 '+task.plan.contact+'。';markMainPageDirty('inventory','orders.list','orders.po','admin');root.renderInventoryShipping?.();}
      });
    }catch(error){
      try{await update(a,id,task=>task?{...task,error:'寄貨結果待核對：'+String(error.message||error)}:null);}
      catch(_){if(same(a))notice='寄貨進度儲存失敗，請保留此瀏覽器並核對原操作。';}
    }finally{
      active.delete(id);
      if(same(a))root.renderWarehouseParcels();
    }
  }
  root.resumeWarehouseParcel=function(id){
    try{
      const a=actor();notice='';
      if(!read(a).some(t=>t.id===id))throw Error('找不到原寄貨紀錄。');
      void run(a,id);
    }catch(error){showActionFeedback(error.message,'warning');}
  };
  if(typeof window!=='undefined')window.addEventListener('storage',event=>{
    try{if(event.key===storageKey(actor()))root.renderWarehouseParcels();}catch(_){}
  });
})(globalThis);
