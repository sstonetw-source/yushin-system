/* Recipient cards and durable browser jobs call the existing warehouse writers. */
(function(root){
  'use strict';
  let groups=[],branchLists=[],branchActorKey='',editing=null,notice='',visibleLimit=50;
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
  // A read-only dispatch notice. Reuse the same order/transfer projections as
  // the existing shipping actions; never create another stock writer.
  function branchDispatchLists(parcelGroups,transfers){
    const main=defaultWarehouse()?.id||'',map=new Map();
    function append(warehouseId,entry){
      if(!warehouseId||warehouseId===main)return;
      const warehouse=warehouseMasterCache.find(w=>w.id===warehouseId);
      if(!warehouse||warehouse.active===false||warehouse.systemCustody)return;
      if(!map.has(warehouseId))map.set(warehouseId,{warehouseId,warehouseName:warehouse.warehouseName||warehouseId,entries:[]});
      map.get(warehouseId).entries.push(entry);
    }
    for(const group of parcelGroups)for(const row of group.rows){
      const item=row.item||{},order=row.order||{};
      append(group.warehouseId,{key:'shipment:'+row.key,kind:group.plan.mode==='CUSTOMER_SHIP'?'寄給客戶':'寄給業務',
        source:order.orderNo||order.quoteNo||order.id||'訂單',itemCode:item.itemCode||'',itemName:item.itemName||'',qty:Number(row.qty),
        recipient:{contact:group.plan.contact,phone:group.plan.phone,address:group.plan.address},ready:true});
    }
    for(const row of transfers||[])append(row.warehouseId,{key:'transfer:'+row.key,kind:row.kind==='order'?'訂單調回主倉':'備貨調回主倉',
      source:row.source||row.id,itemCode:row.itemCode||'',itemName:row.itemName||'',qty:Number(row.qty),
      recipient:row.recipient||{},ready:row.ready===true});
    return [...map.values()].map(group=>({...group,entries:group.entries.sort((a,b)=>a.key.localeCompare(b.key))}))
      .sort((a,b)=>a.warehouseName.localeCompare(b.warehouseName,'zh-Hant'));
  }
  const branchListSignature=group=>JSON.stringify(group?.entries.map(entry=>[entry.key,entry.kind,entry.source,entry.itemCode,
    entry.itemName,entry.qty,entry.recipient.contact,entry.recipient.phone,entry.recipient.address,entry.ready])||[]);
  const branchListComplete=group=>group?.entries.length>0&&group.entries.every(entry=>Number.isFinite(entry.qty)&&entry.qty>0
    &&entry.recipient.contact&&entry.recipient.phone&&entry.recipient.address);
  function branchNoticeText(group){
    return ['【又鑫｜分倉備貨及出貨通知】','分倉：'+group.warehouseName,'日期：'+localDateString(),
      '以下為備貨／寄貨通知，不代表系統已出庫或客戶已送達。','',...group.entries.flatMap((entry,i)=>[
        `${i+1}. ${entry.kind}｜${entry.source}`,
        `${entry.itemCode} ${entry.itemName} × ${entry.qty}`.trim(),
        `收件：${entry.recipient.contact}｜${entry.recipient.phone}`,
        `地址：${entry.recipient.address}`,
        `狀態：${entry.ready?'可核對寄出':'待備妥／打單確認（不可先寄出）'}`,'']),
      '請依實際寄貨內容回又鑫系統逐筆確認寄出；調回主倉的貨需由主倉另外點收。'].join('\n');
  }
  root.shareBranchDispatchList=async function(warehouseId,share=false,button){
    try{
      const a=actor(),previous=branchLists.find(g=>g.warehouseId===warehouseId);
      if(branchActorKey!==storageKey(a))throw Error('登入帳號或角色已變更，請重新載入清單。');
      if(!previous)throw Error('分倉清單已更新，請重新載入。');
      // Browser clipboard/share permissions require the user's original click;
      // do not await a network request before invoking them. This is a notice,
      // not authorization or confirmation of a stock transaction.
      if(!same(a)||!orderWorkQueueReady||orderWorkQueueError)throw Error('登入身分或訂單清單已變更，請重新載入。');
      const transfers=root.mainTransferParcelEntries?.();
      if(!transfers?.ready||transfers.error||transfers.hasMore)throw Error('主倉調回清單尚未完整讀取，請先核對。');
      const tasks=read(a),fresh=branchDispatchLists(groupRows(root.warehouseParcelSourceRows?.()||[])
        .filter(g=>!blocked(g.rows,tasks)),transfers.entries).find(g=>g.warehouseId===warehouseId);
      if(branchListSignature(fresh)!==branchListSignature(previous))throw Error('清單內容已更新，請檢查後再傳送。');
      if(!branchListComplete(fresh))throw Error('收件資料不完整，請補齊後再傳送。');
      if(button)button.disabled=true;
      const message=branchNoticeText(fresh);
      if(share&&typeof navigator.share==='function')await navigator.share({title:'分倉出貨通知｜'+fresh.warehouseName,text:message});
      else{
        if(!navigator.clipboard?.writeText)throw Error('瀏覽器不支援直接複製，請在 Safari／Chrome 的安全網址開啟。');
        await navigator.clipboard.writeText(message);
        showActionFeedback('已複製 '+fresh.warehouseName+' 出貨清單，可貼到 LINE 或 Email。','success');
      }
    }catch(error){if(error?.name!=='AbortError')showActionFeedback('清單未傳送：'+error.message,'warning');}
    finally{if(button)button.disabled=false;}
  };
  function stoppedTask(task){
    if(active.has(task.id))return false;
    return ['unsupported-reservation-location','production-order-transfer-disabled'].includes(task.errorCode)
      ||String(task.error||'').startsWith('寄貨已停止：')
      ||(/^寄貨結果待核對：預留「[^」]+」含尚未啟用的位置資料，已停止作業。/.test(String(task.error||'')));
  }
  function taskMessage(task){
    const message=String(task.error||'上次寄貨尚未確認，請核對原操作。');
    return stoppedTask(task)?message.replace(/^寄貨結果待核對：/,'寄貨已停止：'):message;
  }
  function taskCards(tasks){
    return tasks.filter(t=>!active.has(t.id)).map(t=>'<article class="parcel-card parcel-task"><strong>'+escapeHtml(t.plan.contact)+'</strong><p role="status">'+
      (active.has(t.id)?'寄出中…':escapeHtml(taskMessage(t)))+'</p><p>已確認 '+t.jobs.filter(j=>j.done).length+'／'+t.jobs.length+' 個品項</p>'+
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
      branchLists=kind==='branch'?branchDispatchLists(groups,transferRows):[];
      branchActorKey=storageKey(a);
      const branchNotices=branchLists.map(group=>{
        const complete=branchListComplete(group),key=inlineJsValue(group.warehouseId);
        const pending=group.entries.filter(entry=>!entry.ready).length;
        return '<section class="parcel-branch-list" data-branch-list="'+escapeAttr(group.warehouseId)+'"><header><div><h3>'+escapeHtml(group.warehouseName)+'｜分倉出貨清單</h3><p>'+group.entries.length+' 筆需求'+(pending?'，'+pending+' 筆待備妥':'')+'</p></div><div class="parcel-branch-actions">'+
          '<button type="button" class="btn-secondary" onclick="shareBranchDispatchList('+key+',false,this)" '+(complete&&transfers?.ready&&!transfers.error&&!transfers.hasMore?'':'disabled')+'>複製清單</button>'+
          '<button type="button" onclick="shareBranchDispatchList('+key+',true,this)" '+(complete&&transfers?.ready&&!transfers.error&&!transfers.hasMore?'':'disabled')+'>分享清單</button></div></header>'+
          '<div class="table-wrap"><table><thead><tr><th>寄送用途／單號</th><th>收件對象</th><th>貨品</th><th>數量</th><th>狀態</th></tr></thead><tbody>'+group.entries.map(entry=>
            '<tr><td data-th="用途">'+escapeHtml(entry.kind)+'<small>'+escapeHtml(entry.source)+'</small></td><td data-th="收件">'+escapeHtml(entry.recipient.contact||'待補')+'<small>'+escapeHtml(entry.recipient.address||'待補')+'</small></td><td data-th="貨品">'+escapeHtml(entry.itemCode)+'<small>'+escapeHtml(entry.itemName)+'</small></td><td data-th="數量">'+entry.qty+'</td><td data-th="狀態">'+(entry.ready?'待確認寄出':'待備妥／打單')+'</td></tr>').join('')+'</tbody></table></div>'+
          (!complete?'<p class="parcel-guard-note">請補齊寄往主倉／業務／客戶的收件資訊，再分享清單。</p>':'')+
          (transfers?.hasMore?'<p class="parcel-guard-note">主倉調回需求超過 50 筆，目前不能分享不完整清單。</p>':'')+
          '<p class="parcel-meta">發送前請先確認目前清單已更新；清單只供通知，實際寄出後仍須逐筆按「確認寄出」，不會因分享而扣庫存。</p></section>';
      }).join('');
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
      const individualCards=groups.slice(0,visibleLimit).map((g,index)=>{
        const p=g.plan,wh=warehouseMasterCache.find(w=>w.id===g.warehouseId);
        const complete=p.contact&&p.phone&&p.address;
        const items=root.YushinWarehouseLogistics.aggregateRows(g.rows);
        return '<article class="parcel-card parcel-simple-card" data-shipping-warehouse="'+escapeAttr(g.warehouseId)+'" data-order-ids="'+escapeAttr(g.rows.map(r=>r.order.id).join(','))+'"><div class="parcel-destination"><span class="parcel-field-caption">寄給誰／寄到哪裡</span><h3>'+escapeHtml(p.contact||'待補收件人')+'</h3><p class="parcel-address">'+escapeHtml(p.address||'尚未填寫收件地址')+'</p><p class="parcel-recipient-phone">'+escapeHtml(p.phone||'電話待補')+'</p></div>'+
          '<div class="parcel-contents"><strong class="parcel-field-caption">要寄的貨品</strong><ul class="parcel-items">'+items.map(item=>'<li><span>'+escapeHtml(item.item.itemCode)+'　'+escapeHtml(item.item.itemName)+'</span><strong>× '+item.qty+'</strong></li>').join('')+'</ul></div>'+
          '<details class="parcel-extra-details"><summary>更多資訊／修改收件資料</summary><p>來源：'+escapeHtml(wh?.warehouseName||g.warehouseId)+'</p><p>寄送方式：'+escapeHtml(root.YushinWarehouseLogistics.modes[p.mode])+'</p><p>電話：'+escapeHtml(p.phone||'待補')+'</p>'+g.rows.map(r=>'<p>'+escapeHtml(r.order.orderNo||r.order.quoteNo||'來源訂單')+' · '+escapeHtml(r.order.customerName||'')+' · '+escapeHtml(r.order.salesName||'')+'</p><button type="button" class="btn-secondary" onclick="openWarehouseDeliveryPlan('+inlineJsValue(r.order.id)+','+inlineJsValue(r.item.itemId)+')">編輯收件資料</button>').join('')+'<p>'+escapeHtml(p.notes)+'</p></details>'+
          '<div class="parcel-actions">'+(complete?'<button type="button" class="btn-secondary" onclick="printWarehouseParcel('+index+',this)">列印貼紙</button><button type="button" onclick="openWarehouseParcel('+index+',this)">確認寄出</button>':
          '<button type="button" onclick="openWarehouseDeliveryPlan('+inlineJsValue(g.rows[0].order.id)+','+inlineJsValue(g.rows[0].item.itemId)+')">補收件資料</button>')+'</div></article>';
      }).join('')+transferCards+(groups.length>visibleLimit?'<button type="button" class="btn-secondary" onclick="loadMoreWarehouseParcels()">載入更多寄貨</button>':'');
      const confirmCards=branchNotices?'<details class="parcel-branch-confirmations"><summary>逐筆確認寄出（'+(groups.length+transferRows.length)+'）</summary><div class="parcel-branch-confirmation-cards">'+individualCards+'</div></details>':individualCards;
      host.innerHTML=(branchNotices?'<div class="parcel-branch-toolbar"><strong>各分倉出貨通知</strong><button type="button" class="btn-secondary" onclick="retryInventoryWorkspace(this)">重新整理清單</button></div>':'')+
        branchNotices+taskCards(scopedTasks)+recoveryCards+confirmCards+
        (transfers?.error?'<p class="parcel-guard-note" role="alert">調撥資料讀取失敗：'+escapeHtml(transfers.error)+' <button type="button" onclick="loadMainTransferRequests(true)">重新載入</button></p>':'')+
        (transfers?.hasMore?'<p class="parcel-guard-note">備貨需求先顯示 50 筆，處理後會載入後續項目。</p>':'')+
        (!groups.length&&!transferRows.length&&!scopedTasks.length&&!recoveryCards&&orderWorkQueueReady&&!orderWorkQueueError&&(!transfers||transfers.ready&&!transfers.error)?'<p class="parcel-empty-state">目前沒有需要寄出的貨品。</p>':'');
      if(status)status.textContent=notice||(orderWorkQueueError?'寄貨清單讀取失敗，請重新載入。':!orderWorkQueueReady||transfers&&!transfers.ready?'正在讀取寄貨資料…':(groups.length+transferRows.length)+' 件待寄貨'+(tasks.some(stoppedTask)?' · '+tasks.filter(stoppedTask).length+' 件已停止':'')+(tasks.some(t=>!stoppedTask(t))?' · '+tasks.filter(t=>!stoppedTask(t)).length+' 件處理中／待核對':'')+(groups.length>visibleLimit?'，已顯示部分品項。':''));
    }catch(error){
      branchLists=[];branchActorKey='';
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
    const uiAction=beginUiWorkAction('warehouse-parcel',id,`寄貨確認 ${id}`,()=>{
      if(same(a))root.renderWarehouseParcels();
    },{resume:true});
    root.renderWarehouseParcels();
    let resolved=false,definitivelyBlocked=false;
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
        resolved=true;
        if(same(a)){notice='已確認寄出給 '+task.plan.contact+'。';markMainPageDirty('inventory','orders.list','orders.po','admin');root.renderInventoryShipping?.();}
      });
    }catch(error){
      // The legacy transaction guard rejects unsupported location ledgers
      // before committing. Keep the frozen task for later recovery, but do not
      // report a known precondition rejection as a background unknown result.
      definitivelyBlocked=error?.code==='unsupported-reservation-location'
        ||error?.code==='production-order-transfer-disabled';
      const description=(definitivelyBlocked?'寄貨已停止：':'寄貨結果待核對：')+String(error.message||error);
      try{await update(a,id,task=>task?{...task,error:description,errorCode:String(error?.code||'')}:null);}
      catch(_){if(same(a))notice='寄貨進度儲存失敗，請保留此瀏覽器並核對原操作。';}
    }finally{
      active.delete(id);
      uiAction?.finish(resolved?'success':definitivelyBlocked?'failed':'unknown');
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
