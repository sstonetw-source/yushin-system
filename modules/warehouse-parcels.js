/* Recipient cards and durable browser jobs call the existing warehouse writers. */
(function(root){
  'use strict';
  let groups=[],editing=null,notice='',visibleLimit=50;
  const active=new Set();
  const el=id=>document.getElementById(id);
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
      const warehouse=el('parcelWarehouseFilter')?.value||'',mode=el('inventoryDeliveryModeFilter')?.value||'';
      rows=rows.filter(row=>(!warehouse||row.warehouseId===warehouse)&&(!mode||root.YushinWarehouseLogistics.plan(row.item.deliveryPlan||row.order.shippingInstructions||{}).mode===mode));
      groups=groupRows(rows).filter(g=>!blocked(g.rows,tasks));
      host.innerHTML=taskCards(tasks)+groups.slice(0,visibleLimit).map((g,index)=>{
        const p=g.plan,wh=warehouseMasterCache.find(w=>w.id===g.warehouseId);
        const complete=p.contact&&p.phone&&p.address;
        const items=root.YushinWarehouseLogistics.aggregateRows(g.rows);
        return '<article class="parcel-card"><header><h3>'+escapeHtml(p.contact||'待補收件人')+'</h3><span>'+escapeHtml(root.YushinWarehouseLogistics.modes[p.mode])+'</span></header>'+
          '<p class="parcel-meta">'+escapeHtml(wh?.warehouseName||g.warehouseId)+'出貨</p>'+
          '<p>'+escapeHtml(p.phone)+'</p><p class="parcel-address">'+escapeHtml(p.address)+'</p>'+
          '<ul class="parcel-items">'+items.map(item=>'<li><span>'+escapeHtml(item.item.itemCode)+'　'+escapeHtml(item.item.itemName)+'</span><strong>× '+item.qty+'</strong></li>').join('')+'</ul>'+
          '<details><summary>訂單與寄送明細</summary>'+g.rows.map(r=>'<p>'+escapeHtml(r.order.orderNo||r.order.quoteNo||'來源訂單')+' · '+escapeHtml(r.order.customerName||'')+' · '+escapeHtml(r.order.salesName||'')+'</p><button type="button" class="btn-secondary" onclick="openWarehouseDeliveryPlan('+inlineJsValue(r.order.id)+','+inlineJsValue(r.item.itemId)+')">編輯收件資料</button>').join('')+'<p>'+escapeHtml(p.notes)+'</p></details>'+
          '<div class="parcel-actions">'+(complete?'<button type="button" class="btn-secondary" onclick="printWarehouseParcel('+index+',this)">列印貼紙</button><button type="button" onclick="openWarehouseParcel('+index+',this)">確認寄出</button>':
          '<button type="button" onclick="openWarehouseDeliveryPlan('+inlineJsValue(g.rows[0].order.id)+','+inlineJsValue(g.rows[0].item.itemId)+')">補收件資料</button>')+'</div></article>';
      }).join('')+(groups.length>visibleLimit?'<button type="button" class="btn-secondary" onclick="loadMoreWarehouseParcels()">載入更多待寄貨</button>':'');
      if(status)status.textContent=notice||(orderWorkQueueError?'寄貨清單讀取失敗，請重新載入。':!orderWorkQueueReady?'正在讀取待寄貨…':groups.length+' 件待寄貨'+(tasks.length?' · '+tasks.length+' 件處理中／待核對':'')+(groups.length>visibleLimit?'，已顯示 '+visibleLimit+' 件。':''));
      const select=el('parcelWarehouseFilter');
      if(select){
        const value=select.value;
        select.innerHTML='<option value="">全部出貨倉庫</option>'+warehouseMasterCache.filter(w=>w.active!==false&&!w.systemCustody).map(w=>'<option value="'+escapeAttr(w.id)+'">'+escapeHtml(w.warehouseName||w.id)+'</option>').join('');
        select.value=value;
      }
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
        '<div class="parcel-confirm-items">'+jobs.map((j,i)=>'<label><span>'+escapeHtml(j.row.item.itemCode)+' '+escapeHtml(j.row.item.itemName)+'</span><input aria-label="本次寄出數量" data-parcel-quantity="'+i+'" type="number" min="0" step="any" max="'+j.qty+'" value="'+j.qty+'" '+(j.plan.mode==='CUSTOMER_SHIP'&&!j.priorShipment?'':'readonly')+'></label>').join('')+'</div>'+
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
        if(!Number.isFinite(qty)||qty<=0||qty>job.row.qty||((job.priorShipment||job.plan.mode!=='CUSTOMER_SHIP')&&qty!==job.qty))throw Error('請核對本次寄出數量。');
        job.qty=qty;
      });
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
