/* Warehouse delivery instructions, immutable transfers and address labels.
   Customer delivery remains the existing order workflow; transfers never create deliveryRecords. */
(function(root){
  const modes={PICKUP:'主倉自領',SALES_SHIP:'寄給負責業務',CUSTOMER_SHIP:'直接寄客戶',TRANSFER:'轉送倉庫'};
  // packages is a fixed protocol field required by the current rules, not courier box count.
  function plan(value={}) {
    return {mode:Object.hasOwn(modes,value.mode)?value.mode:'',contact:String(value.contact||'').trim(),phone:String(value.phone||'').trim(),address:String(value.address||'').trim(),warehouseId:String(value.warehouseId||''),packages:1,notes:String(value.notes||'')};
  }
  function validatePlan(value,requireRecipient=false){
    const p=plan(value);
    if(!p.mode)throw Error('請選擇主倉自領、寄給負責業務或直接寄客戶。');
    if(p.mode==='TRANSFER'&&!p.warehouseId)throw Error('請選擇收貨倉庫。');
    if(requireRecipient&&p.mode!=='PICKUP'&&(!p.contact||!p.phone||!p.address))throw Error('請填齊收件人、聯絡電話與完整收件地址，再儲存或寄送。');
    for(const key of ['contact','phone','address','notes'])if(p[key].length>1000)throw Error('收件資訊過長。');
    return p;
  }
  function executionPlan(row,warehouses,mainId){
    const p=plan(row.item.deliveryPlan||row.order.shippingInstructions||{});
    const target=p.mode==='PICKUP'?mainId:p.mode==='TRANSFER'?p.warehouseId:'';
    if(p.mode==='PICKUP'&&target&&target!==row.warehouseId){
      const wh=warehouses.find(w=>w.id===target&&w.active!==false&&!w.systemCustody);
      return plan({...p,mode:'TRANSFER',warehouseId:target,notes:'',contact:wh?.contact||wh?.contactName||wh?.warehouseName||'',phone:wh?.phone||'',address:wh?.address||wh?.shippingAddress||''});
    }
    return p;
  }
  function businessDeliveryState(order,item,state,mainId){
    if((item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP')return state;
    const p=plan(item.deliveryPlan||order.shippingInstructions||{}),warehouseId=item.warehouseId||order.warehouseId||mainId;
    const custody=String(warehouseId).startsWith('custody-');
    if(p.mode==='PICKUP'&&warehouseId===mainId)return state;
    if(p.mode==='SALES_SHIP'&&custody)return state;
    const deliveryWait=p.mode==='PICKUP'?'待調回主倉':p.mode?'待倉管寄貨':'待設定交付方式';
    return {...state,shippable:0,deliveryWait};
  }
  function transferRequirements(orders,warehouses,mainId,helpers){
    const result=[],seen=new Set();
    for(const order of orders||[]){
      if(seen.has(order.id)||helpers.status(order)!=='normal'||helpers.incomplete(order))continue;seen.add(order.id);
      for(const item of helpers.items(order)){
        const source=item.warehouseId||order.warehouseId||mainId,warehouse=warehouses.find(w=>w.id===source&&w.active!==false&&!w.systemCustody);
        if(!warehouse||source===mainId||item.transferPendingId||(item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP')continue;
        const qty=Math.max(0,Number(item.qty||item.orderedQty||0)-Math.max(0,Number(item.deliveredQty||0)-Number(item.returnedQty||0)));
        const row={order,item,qty,warehouseId:source,warehouse,branch:true,key:order.id+'__'+item.itemId};
        if(qty>0&&plan(item.deliveryPlan||order.shippingInstructions||{}).mode==='PICKUP'&&executionPlan(row,warehouses,mainId).mode==='TRANSFER'){row.readyQty=Math.min(qty,Math.max(0,Number(helpers.dispatch(order,item).shippable||0)));result.push(row);}
      }
    }
    return result;
  }
  function aggregateRows(rows){
    const groups=new Map(),seen=new Set();
    for(const r of rows){
      if(r.key&&seen.has(r.key))continue;if(r.key)seen.add(r.key);
      const key=r.item.productId||r.item.productKey?JSON.stringify(['product',r.item.productId||r.item.productKey]):JSON.stringify(['unmatched',r.item.brandId||r.item.brand||'',r.item.itemCode||'',r.item.spec||'',r.item.itemName||'']);
      if(!groups.has(key))groups.set(key,{item:r.item,qty:0,rows:[]});
      const g=groups.get(key);g.qty+=Number(r.qty);g.rows.push(r);
    }
    return [...groups.values()];
  }
  function bundleKey(row,p){return JSON.stringify([row.warehouseId,p.mode,p.warehouseId,p.contact,p.phone,p.address,p.notes]);}
  function partition(rows,getPlan){const groups=new Map();for(const row of rows){const p=validatePlan(getPlan(row),true),key=bundleKey(row,p);if(!groups.has(key))groups.set(key,{warehouseId:row.warehouseId,plan:p,rows:[]});groups.get(key).rows.push(row);}return [...groups.values()];}
  function transferable(stock,qty,reservedQty=0){
    if(!Number.isFinite(qty)||qty<=0)throw Error('數量必須大於 0。');
    if(!Number.isFinite(reservedQty)||reservedQty<0||reservedQty>qty)throw Error('預留數量不正確。');
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
    const cell=value=>{let text=String(value??'');if(/^[\s\uFEFF]*[=+@-]/.test(text))text="'"+text;return '"'+text.replace(/"/g,'""')+'"';};
    const header=['出貨倉庫','交付方式','收件人','電話','地址','配送備註','訂單單號','業務','客戶','貨號','品名','本次數量','已打單可出數量'];
    const data=groups.flatMap(g=>aggregateRows(g.rows).map(a=>{const r=a.rows[0];return [g.warehouseName||g.warehouseId,modes[g.plan.mode],g.plan.contact,g.plan.phone,g.plan.address,g.plan.notes,a.rows.map(x=>(x.order.orderNo||x.order.quoteNo||x.order.id||'')+' × '+x.qty).join('；'),[...new Set(a.rows.map(x=>x.order.salesName))].join('、'),[...new Set(a.rows.map(x=>x.order.customerName))].join('、'),r.item.itemCode,r.item.itemName,a.qty,a.rows.reduce((n,x)=>n+Number(x.readyQty??x.qty),0)];}));
    return '\uFEFF'+[header,...data].map(row=>row.map(cell).join(',')).join('\r\n');
  }
  function shippingStatus(order,item,state){
    const total=Number(item.orderedQty||item.qty||0),delivered=Number(state.delivered||0);
    const customerShipment=(order.deliveryRecords||[]).some(record=>record.itemId===item.itemId&&record.sourceType==='INVENTORY_SHIPMENT');
    if(total>0&&delivered>=total)return customerShipment?'已送貨（已寄客戶）':'已送貨';
    if(item.transferPendingId)return '轉倉途中';
    if(String(item.warehouseId||'').startsWith('custody-'))return (item.deliveryPlan||order.shippingInstructions||{}).mode==='SALES_SHIP'?'已寄負責業務・待送客戶':'已交付負責業務・待送客戶';
    if(delivered>0)return `${customerShipment?'部分已寄客戶':'部分已送貨'} ${delivered}／${total}`;
    if((order.logisticsHistory||[]).some(h=>h.itemId===item.itemId&&h.action==='倉庫調撥收貨'))return '已轉倉・待送客戶';
    return '';
  }
  const api={modes,plan,executionPlan,transferRequirements,businessDeliveryState,aggregateRows,validatePlan,bundleKey,partition,transferable,batchJobs,processBatch,csvDocument,shippingStatus};root.YushinWarehouseLogistics=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(typeof document==='undefined')return;
  const $=id=>document.getElementById(id);
  let transfers=[],queueReady=false,queueError='',queueContext='',queuePromise=null,editor=null;
  const selected=new Set(),pending=new Set();let transferLimit=50,visibleRows=[],shippingBatch=null,batchOpening=false;
  function allowed(){return canReceiveInventoryCapability()&&canAccessPage('inventory');}
  function rows(includeCustody=false){return root.YushinInventoryWorkspace.shippingRows(orderWorkQueueCache,warehouseMasterCache,defaultWarehouse()?.id||'',{status:normalizedOrderStatus,incomplete:orderInventorySyncIncomplete,items:normalizedOrderItems,dispatch:itemDispatchState,includeCustody,
    pending:(orderId,itemId)=>typeof pendingV2WarehouseShipment==='function'?pendingV2WarehouseShipment(orderId,itemId):null});}
  function rowPlan(row){return executionPlan(row,warehouseMasterCache,defaultWarehouse()?.id||'');}
  function savedRowPlan(row){return plan(row.item.deliveryPlan||row.order.shippingInstructions||{});}
  function canSetPlan(order){return allowed()||(canManageOrderLifecycleCapability()&&canEditPage('orders.list')&&order.ownerUid===currentUser?.uid);}
  function context(){return currentUser?.uid+'|'+currentUserRole;}
  root.resetWarehouseLogistics=function(){transfers=[];selected.clear();visibleRows=[];shippingBatch=null;queueReady=false;queueError='';queueContext='';queuePromise=null;editor=null;root.resetDeliverySettings?.();root.resetMainTransferRequests?.();$('warehouseLogisticsOverlay')?.remove();};
  root.loadWarehouseTransferQueue=async function(force=false){
    if(!allowed())return;
    const ctx=context();if(queueContext!==ctx){root.resetWarehouseLogistics();queueContext=ctx;}
    if(queuePromise)return queuePromise;if(queueReady&&!force)return root.renderWarehouseTransfers();
    queueReady=false;queueError='';root.renderWarehouseTransfers();
    const task=(async()=>{try{
      const [snapshot,allocationSnapshot]=await Promise.all([
        firestoreReadWithTimeout(db.collection('stockTransfers').where('status','==','IN_TRANSIT').limit(50).get(),'倉庫調撥收貨'),
        firestoreReadWithTimeout(db.collection('stockTransfers').where('status','==','RECEIVED').where('allocationCompleted','==',false).limit(50).get(),'調撥入庫後分配進度')
      ]);
      if(ctx!==context())return;
      transfers=[...snapshot.docs,...allocationSnapshot.docs].map(doc=>({...doc.data(),id:doc.id}));queueReady=true;
    }catch(err){if(ctx!==context())return;queueError=err.code==='permission-denied'?'調撥功能所需的 Firestore 規則尚未部署。':'調撥資料讀取失敗：'+err.message;
    }finally{if(ctx===context()){queuePromise=null;root.renderWarehouseTransfers();root.updateInventoryWorkspaceBadges?.();}}})();queuePromise=task;return task;
  };
  root.warehouseTransferQueueState=()=>({ready:queueReady,error:queueError,count:transfers.length,hasMore:transfers.length>=50});
  root.renderWarehouseTransfers=function(){
    const body=$('inventoryTransferReceivingBody');if(!body)return;
    body.innerHTML=transfers.map(t=>`<tr><td data-th="來源">${escapeHtml(t.orderId?'業務訂單':'庫存調撥')}<br>${escapeHtml(t.orderNo||t.id)}<br>${escapeHtml(t.salesName||'')}</td><td data-th="寄出方／目的倉">${escapeHtml(warehouseName(t.fromWarehouseId))} → ${escapeHtml(warehouseName(t.toWarehouseId))}</td><td data-th="品項">${escapeHtml(t.itemCode)}<br>${escapeHtml(t.itemName)}</td><td data-th="待收數量">${t.status==='RECEIVED'?'已入庫・待分配':t.qty}</td><td data-th="操作"><button type="button" onclick="receiveWarehouseTransfer(${inlineJsValue(t.id)},this)">${t.status==='RECEIVED'?'重試庫存分配':'已收貨'}</button></td></tr>`).join('');
    $('inventoryTransferReceivingStatus').textContent=queueError||(!queueReady?'讀取中…':`${transfers.length} 筆調撥收貨／待分配${transfers.length>=50?'，各類先顯示 50 筆；處理後補入下一批':''}。已入庫的重試只處理分配，不重複入庫。`);
    const card=$('inventoryTransferReceivingTab');if(card)card.innerHTML=`<span>調撥收貨</span><strong>${queueError?'—':queueReady?transfers.length+' 筆':'…'}</strong>`;
  };
  function warehouseName(id){return warehouseMasterCache.find(w=>w.id===id)?.warehouseName||id;}
  function modal(html){let overlay=$('warehouseLogisticsOverlay');if(!overlay){overlay=document.createElement('div');overlay.id='warehouseLogisticsOverlay';overlay.className='eq-modal-overlay no-print';overlay.addEventListener('click',e=>{if(e.target===overlay)root.closeWarehouseLogistics();});document.body.appendChild(overlay);}overlay.innerHTML=`<div class="eq-modal-box warehouse-logistics-modal">${html}</div>`;overlay.classList.add('active');}
  root.closeWarehouseLogistics=function(){if(editor?.busy||shippingBatch?.busy)return;editor=null;shippingBatch=null;$('warehouseLogisticsOverlay')?.classList.remove('active');updateSelection();};
  function fields(p,prefix='logistics'){
    return `<div class="form-grid"><label>交付方式<select id="${prefix}Mode" onchange="warehouseDeliveryModeChanged('${prefix}')"><option value="" ${!p.mode?'selected':''}>請選擇交付方式</option>${Object.entries(modes).filter(([k])=>k!=='TRANSFER').map(([k,v])=>`<option value="${k}" ${p.mode===k?'selected':''}>${v}</option>`).join('')}</select></label><label hidden>主倉庫<select id="${prefix}Warehouse" onchange="warehouseDeliveryModeChanged('${prefix}',true)"><option value="">直接交付／寄送</option>${warehouseMasterCache.filter(w=>w.active!==false&&!w.systemCustody).map(w=>`<option value="${escapeAttr(w.id)}" ${p.warehouseId===w.id?'selected':''}>${escapeHtml(w.warehouseName)}</option>`).join('')}</select></label><label>收件人<input id="${prefix}Contact" value="${escapeAttr(p.contact)}"></label><label>聯絡電話<input id="${prefix}Phone" value="${escapeAttr(p.phone)}"></label><label class="logistics-wide">完整收件地址<input id="${prefix}Address" value="${escapeAttr(p.address)}"></label><label class="logistics-wide">配送備註<input id="${prefix}Notes" value="${escapeAttr(p.notes)}"></label></div>`;
  }
  function readFields(prefix='logistics'){return plan(Object.fromEntries(['mode','warehouseId','contact','phone','address','notes'].map(key=>[key,$(prefix+({warehouseId:'Warehouse'}[key]||key[0].toUpperCase()+key.slice(1)))?.value||''])));}
  root.warehouseDeliveryModeChanged=function(prefix='logistics',fillWarehouse=false){
    const mode=$(prefix+'Mode')?.value,w=$(prefix+'Warehouse');if(w)w.value=mode==='PICKUP'?(defaultWarehouse()?.id||''):'';if(w)w.closest('label').style.display='none';
    if(mode==='TRANSFER'&&fillWarehouse){const wh=warehouseMasterCache.find(x=>x.id===w.value);if(wh){$(prefix+'Address').value=wh.address||wh.shippingAddress||'';$(prefix+'Contact').value=wh.contact||wh.contactName||wh.warehouseName;$(prefix+'Phone').value=wh.phone||'';}}
    if(prefix==='logistics'&&editor&&['PICKUP','SALES_SHIP'].includes(mode)){
      const person=salesList.find(s=>s.uid===editor.row.order.ownerUid||s.code===editor.row.order.salesCode);
      if(!$(prefix+'Contact').value)$(prefix+'Contact').value=person?.name||editor.row.order.salesName||'';
      if(!$(prefix+'Phone').value)$(prefix+'Phone').value=person?.deliveryDefaults?.phone||person?.phone||'';
      if(mode==='SALES_SHIP'&&!$(prefix+'Address').value)$(prefix+'Address').value=person?.deliveryDefaults?.address||'';
    }
  };
  root.refreshOrderShippingWarehouses=function(){
    const field=$('orderShippingWarehouse');if(!field)return;const current=field.value;
    field.innerHTML='<option value="">選擇倉庫</option>'+warehouseMasterCache.filter(w=>w.active!==false&&!w.systemCustody).map(w=>`<option value="${escapeAttr(w.id)}">${escapeHtml(w.warehouseName)}</option>`).join('');field.value=current;
  };
  root.orderShippingInstructions=()=>readFields('orderShipping');
  root.setOrderShippingInstructions=function(value={}){const host=$('orderShippingFields');if(!host)return;host.innerHTML=fields(plan(value),'orderShipping');root.warehouseDeliveryModeChanged('orderShipping');};
  root.openWarehouseDeliveryPlan=async function(orderId,itemId){
    if(shippingBatch?.busy)return;const order=ordersCache.find(o=>o.id===orderId)||orderWorkQueueCache.find(o=>o.id===orderId);if(!order||!canSetPlan(order))return;const item=normalizedOrderItems(order).find(i=>i.itemId===itemId);if(!item||item.transferPendingId||(String(item.warehouseId||'').startsWith('custody-')&&!allowed()))return showActionFeedback('品項已交付或調撥中，請由倉管確認後續處理。','warning');const row={order,item,qty:itemDispatchState(order,item).shippable,warehouseId:item.warehouseId||order.warehouseId||defaultWarehouse()?.id||''};
    editor={row,id:lifecycleRecordId(),busy:false,uid:currentUser.uid,role:currentUserRole};
    modal(`<h3>交付設定</h3><p>${escapeHtml(row.order.salesName||'未指定負責業務')}｜${escapeHtml(row.order.customerName||'')}<br>${escapeHtml(row.item.itemCode)} ${escapeHtml(row.item.itemName)}｜${escapeHtml(warehouseName(row.warehouseId))}｜待出 ${row.qty}</p>${fields(savedRowPlan(row))}<p class="inventory-work-status">存設定與列印不異動庫存。主倉自領不需倉管登記，業務送貨時才扣帳；寄給負責業務後仍由負責業務登記已送貨。</p><div class="toolbar"><button type="button" id="logisticsSave" onclick="saveWarehouseDeliveryPlan(this)">儲存設定</button><button type="button" class="btn-secondary" onclick="printWarehouseDeliveryEditor('labels')">列印地址貼紙</button><button type="button" class="btn-secondary" onclick="printWarehouseDeliveryEditor('list')">列印出貨清單</button><button type="button" class="btn-secondary" onclick="closeWarehouseLogistics()">關閉</button></div>`);root.warehouseDeliveryModeChanged();
  };
  root.saveWarehouseDeliveryPlan=async function(button){
    if(!editor||editor.busy||!canSetPlan(editor.row.order))return;const entry=editor;let p;
    try{p=validatePlan(readFields(),true);}catch(err){return alert(err.message);}
    entry.busy=true;let committed=false;const bs=beginActionButton(button,'儲存中…');
    try{await runRoleTransaction(async tx=>{
      if(entry.uid!==currentUser.uid||entry.role!==currentUserRole)throw Error('登入身分已變更。');
      const ref=db.collection('orders').doc(entry.row.order.id),snap=await tx.get(ref);if(!snap.exists)throw Error('訂單不存在。');const order=snap.data();
      if(normalizedOrderStatus(order)!=='normal')throw Error('訂單已取消。');
      if((order.logisticsHistory||[]).some(h=>h.id===entry.id))return;
      const index=order.items.findIndex(i=>i.itemId===entry.row.item.itemId);if(index<0)throw Error('品項已變更。');const current=order.items[index];if(current.transferPendingId)throw Error('調撥途中不可變更交付設定。');if(String(current.warehouseId||'').startsWith('custody-')&&p.mode!=='TRANSFER')throw Error('已交付負責業務，只能由倉管設定退回倉庫。');if(itemDispatchState(order,normalizedOrderItems(order)[index]).delivered>=Number(current.qty||current.orderedQty||0))throw Error('已完成交付，不能變更收件資訊。');
      const now=new Date().toISOString(),items=order.items.map((i,n)=>n===index?{...i,deliveryPlan:p}:i);
      tx.update(ref,{items,logisticsPlanEventId:entry.id,logisticsPlanItemIndex:index,logisticsPlanActorUid:currentUser.uid,logisticsHistory:firebase.firestore.FieldValue.arrayUnion({id:entry.id,action:'交付設定',itemId:entry.row.item.itemId,by:deliveryActor(),at:now,detail:modes[p.mode]+'｜'+p.address,deliveryPlan:p}),updatedAt:now});
    });committed=true;await refreshRows(entry.row.order.id);showActionFeedback('交付設定已儲存。');entry.busy=false;root.closeWarehouseLogistics();
    }catch(err){showActionFeedback((committed?'設定已儲存，清單更新失敗：':'儲存失敗：')+err.message,'warning');}finally{entry.busy=false;endActionButton(button,bs);if(editor===entry&&!entry.busy&&$('warehouseLogisticsOverlay')?.classList.contains('active')){/* keep fields on failure */}}
  };
  async function refreshRows(orderId){
    await loadWarehouseMaster(true);if(orderId)await refreshAffectedOrderCaches([orderId]);if(allowed()){await loadOrderWorkQueue(true);root.renderInventoryShipping?.();}root.renderDeliveryModal?.();root.renderOrderLifecycleModal?.();markMainPageDirty('inventory','orders.list','orders.po','admin');
  }
  root.toggleWarehouseShippingSelection=function(orderId,itemId,checked){if(shippingBatch?.busy)return;const key=orderId+'__'+itemId;checked?selected.add(key):selected.delete(key);updateSelection();};
  root.clearWarehouseShippingSelection=()=>{selected.clear();updateSelection();};
  root.isWarehouseShippingSelected=(orderId,itemId)=>selected.has(orderId+'__'+itemId);
  function updateSelection(){
    const status=$('warehouseShippingSelectionStatus'),button=$('warehouseShippingBatchBtn');
    if(status)status.textContent=selected.size?`已勾選 ${selected.size} 個品項`:'尚未勾選品項';
    if(button)button.disabled=!selected.size||!!shippingBatch?.busy||!allowed();
    const all=$('warehouseShippingSelectAll');if(all){all.checked=visibleRows.length>0&&visibleRows.every(r=>selected.has(r.key));all.indeterminate=visibleRows.some(r=>selected.has(r.key))&&!all.checked;}
  }
  root.setWarehouseShippingVisibleRows=function(list){visibleRows=list;if(!shippingBatch?.busy)for(const key of [...selected])if(!list.some(r=>r.key===key))selected.delete(key);updateSelection();};
  root.selectVisibleWarehouseShipping=function(checked){if(!allowed()||shippingBatch?.busy)return;for(const row of visibleRows)checked?selected.add(row.key):selected.delete(row.key);root.renderInventoryShipping?.();};
  async function selectedRows(){
    const ctx=context();
    const keys=[...selected];if(!keys.length)throw Error('請先勾選本批品項。');
    await loadOrderWorkQueue(true);const list=rows().filter(r=>['CUSTOMER_SHIP','SALES_SHIP'].includes(rowPlan(r).mode)&&keys.includes(r.key));
    if(ctx!==context()||!allowed())throw Error('登入身分或權限已變更。');
    if(keys.some(key=>!list.some(r=>r.key===key)))throw Error('部分品項已出貨或狀態變更，請重新勾選。');
    return list;
  }
  root.exportWarehouseTransferRequirements=async function(button){
    if(!allowed())return;const ctx=context(),bs=beginActionButton(button,'匯出中…');
    try{await loadWarehouseMaster(true);await loadOrderWorkQueue(true);if(ctx!==context()||!allowed())throw Error('登入身分已變更。');
      const source=$('inventoryShippingWarehouse')?.value||'',list=transferRequirements(orderWorkQueueCache,warehouseMasterCache,defaultWarehouse()?.id||'',{status:normalizedOrderStatus,incomplete:orderInventorySyncIncomplete,items:normalizedOrderItems,dispatch:itemDispatchState}).filter(r=>!source||r.warehouseId===source);
      if(!list.length)throw Error('目前沒有分倉調撥需求。');const map=new Map();for(const r of list){const p=rowPlan(r),key=bundleKey(r,p);if(!map.has(key))map.set(key,{warehouseId:r.warehouseId,warehouseName:warehouseName(r.warehouseId),plan:p,rows:[]});map.get(key).rows.push(r);}
      const csv=csvDocument([...map.values()]).replace('本次數量','合計需求數量'),url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'})),link=document.createElement('a');link.href=url;link.download='分倉調撥需求-'+localDateString()+'.csv';document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);showActionFeedback('調撥需求已匯出，包含未到齊需求；不會異動庫存。');
    }catch(err){showActionFeedback('匯出失敗：'+err.message,'warning');}finally{endActionButton(button,bs);}
  };
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
    try{const list=await selectedRows();for(const row of list){const p=rowPlan(row),remaining=Number(row.item.qty||row.item.orderedQty||0)-Math.max(0,Number(row.item.deliveredQty||0)-Number(row.item.returnedQty||0));if(p.mode!=='CUSTOMER_SHIP'&&(row.qty!==remaining||row.qty!==Number(row.item.reservedQty)))throw Error(row.item.itemCode+'：需剩餘數量全部到貨、預留並完成打單後才可調撥或交付負責業務。');}const jobs=batchJobs(list,rowPlan,lifecycleRecordId());jobs.forEach(j=>{
        const prior=j.row.priorShipment;
        j.expectedPlan=prior?.expectedPlan||savedRowPlan(j.row);
        if(prior){j.operationId=prior.operationId;j.qty=prior.quantity;j.priorShipment=prior;}
      });
      if(!queueContext)queueContext=context();
      shippingBatch={jobs,uid:currentUser.uid,role:currentUserRole,busy:false};
      modal(`<h3>確認本批已出貨</h3><p>請確認實體貨品已寄出或交付。分倉庫須收到寄出確認後才登記。</p><label>本批日期<input id="warehouseShippingBatchDate" type="date" value="${localDateString()}"></label><label>出貨備註（選填）<input id="warehouseShippingBatchNotes" maxlength="500"></label><div class="table-wrap"><table><thead><tr><th>負責業務／客戶</th><th>品項／目的地</th><th>本次數量</th><th>結果</th></tr></thead><tbody>${jobs.map((j,i)=>`<tr><td>${escapeHtml(j.row.order.salesName)}<br>${escapeHtml(j.row.order.customerName)}</td><td>${escapeHtml(j.row.item.itemCode)} ${escapeHtml(j.row.item.itemName)}<br>${escapeHtml(modes[j.plan.mode])}｜${escapeHtml(j.plan.contact||j.row.order.salesName)}<br>${escapeHtml(j.plan.address)}</td><td><input aria-label="本次出貨數量" data-batch-qty="${i}" type="number" min="0" max="${j.qty}" step="any" value="${j.qty}" ${j.plan.mode==='CUSTOMER_SHIP'?'':'readonly'}></td><td id="warehouseShippingBatchRow${i}">待處理</td></tr>`).join('')}</tbody></table></div><p>${globalThis.YUSHIN_V2_SHIPMENT_EMULATOR===true?'v2 實體出貨只扣庫存，不登錄客戶送達；請後續完成送達確認。':'直接寄客戶按已出貨後會同步登錄已送貨，不代表客戶已簽收；寄給負責業務不需另外確認收貨；負責業務送達客戶後再按已送貨。'}</p><p id="warehouseShippingBatchProgress" role="status"></p><div class="toolbar"><button id="warehouseShippingBatchConfirm" onclick="confirmWarehouseShippingBatch(this)">確認本批已出貨</button><button class="btn-secondary" onclick="closeWarehouseShippingBatch()">關閉</button></div>`);
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
        document.querySelectorAll('[data-batch-qty]').forEach(input=>{const job=batch.jobs[Number(input.dataset.batchQty)],qty=Number(input.value);if(job.priorShipment&&qty!==job.priorShipment.quantity)throw Error('上次出貨數量不可變更，請確認原操作結果。');if(!Number.isFinite(qty)||qty<=0||qty>job.row.qty||(job.plan.mode!=='CUSTOMER_SHIP'&&qty!==job.row.qty))throw Error('請核對本次出貨數量。');job.qty=qty;});
        batch.started=true;document.querySelectorAll('[data-batch-qty],#warehouseShippingBatchDate,#warehouseShippingBatchNotes').forEach(input=>input.disabled=true);
      }
    }catch(err){return showActionFeedback(err.message,'warning');}
    batch.busy=true;const bs=beginActionButton(button,'出貨登記中…');updateSelection();
    try{
      const result=await processBatch(batch.jobs,async job=>{
        if(batch.uid!==currentUser.uid||batch.role!==currentUserRole||!allowed())throw Error('登入身分或權限已變更。');
        const {row,plan:p,qty,operationId}=job;
        if(p.mode==='CUSTOMER_SHIP')await root.commitInventoryShipment({orderId:row.order.id,itemId:row.item.itemId,qty,
          date:job.priorShipment?.date||batch.date,notes:job.priorShipment?job.priorShipment.notes:(batch.notes||p.notes),
          operationId,expectedWarehouseId:row.warehouseId,expectedPlan:job.expectedPlan||savedRowPlan(row)});
        else await root.commitWarehouseTransfer({id:operationId,orderId:row.order.id,itemId:row.item.itemId,qty,handoff:p.mode!=='TRANSFER',toWarehouseId:p.warehouseId,expectedWarehouseId:row.warehouseId,expectedPlan:job.expectedPlan||savedRowPlan(row)});
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
        pages.push(`<section class="label"><h2>收件人：${escapeHtml(p.contact)}</h2><h2>${escapeHtml(p.phone)}</h2><div class="address">${escapeHtml(p.address)}</div><p>${escapeHtml(p.notes)}</p><p>寄出倉庫：${escapeHtml(warehouseName(g.warehouseId))}</p><small>又鑫生物科技｜02-2100-1008<br>訂單：${escapeHtml([...new Set(g.rows.map(r=>r.order.orderNo||r.order.quoteNo||r.order.id))].join('、'))}</small></section>`);
      }else pages.push(`<section><h2>出貨清單｜${escapeHtml(warehouseName(g.warehouseId))}</h2><p>${escapeHtml(modes[p.mode])}</p><p>收件人：${escapeHtml(p.contact)}　電話：${escapeHtml(p.phone)}</p><p>地址：${escapeHtml(p.address)}<br>備註：${escapeHtml(p.notes)}</p><table><thead><tr><th>訂單／負責業務／客戶</th><th>貨號／品名</th><th>數量</th></tr></thead><tbody>${aggregateRows(g.rows).map(a=>`<tr><td>${a.rows.map(r=>escapeHtml(r.order.orderNo||r.order.quoteNo||r.order.id)+'｜'+escapeHtml(r.order.salesName)+'｜'+escapeHtml(r.order.customerName)+' × '+r.qty).join('<br>')}</td><td>${escapeHtml(a.item.itemCode)}<br>${escapeHtml(a.item.itemName)}</td><td>${a.qty}</td></tr>`).join('')}</tbody></table><p>請核對實體數量。本清單與地址貼紙不代表已出貨。</p></section>`);
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
      const groups=partition(list.filter(r=>['CUSTOMER_SHIP','SALES_SHIP'].includes(rowPlan(r).mode)),rowPlan);if(!groups.length)throw Error('請選擇寄給客戶或業務的品項。');printDocument(groups,kind);
    }catch(err){alert(err.message);}finally{endActionButton(button,bs);}
  };
  root.renderWarehouseCustody=function(){
    const host=$('warehouseCustodyQueue');if(!host)return;
    const list=rows(true).filter(r=>r.warehouse?.systemCustody);
    host.innerHTML=list.length?`<details class="warehouse-custody-details"><summary>負責業務保管待送（${list.length}）</summary><div class="table-wrap inventory-work-table"><table><thead><tr><th>負責業務／客戶</th><th>品項</th><th>待送數量</th><th>操作</th></tr></thead><tbody>${list.slice(0,50).map(r=>`<tr><td data-th="負責業務／客戶">${escapeHtml(r.order.salesName)}<br>${escapeHtml(r.order.customerName)}</td><td data-th="品項">${escapeHtml(r.item.itemCode)}<br>${escapeHtml(r.item.itemName)}</td><td data-th="待送數量">${r.qty}</td><td data-th="操作"><button class="btn-secondary" onclick="openWarehouseDeliveryPlan(${inlineJsValue(r.order.id)},${inlineJsValue(r.item.itemId)})">設定退回倉庫</button><button onclick="startOrderWarehouseTransfer(${inlineJsValue(r.order.id)},${inlineJsValue(r.item.itemId)},this)">確認寄回倉庫</button></td></tr>`).join('')}</tbody></table></div></details>`:'';
  };
  root.confirmWarehouseDelivery=async function(orderId,itemId,button){
    if(!allowed())return;const row=rows().find(r=>r.order.id===orderId&&r.item.itemId===itemId);if(!row)return;const p=rowPlan(row);
    if(p.mode==='CUSTOMER_SHIP'){try{validatePlan(p,true);}catch(err){return alert(err.message);}return root.openInventoryShipment(orderId,itemId,button);}
    if(!['CUSTOMER_SHIP','SALES_SHIP'].includes(p.mode))return showActionFeedback('主倉自領不在寄貨清單操作；調回主倉請從庫存清單處理。','warning');
    if(p.mode==='SALES_SHIP'){try{validatePlan(p,true);}catch(err){return alert(err.message);}}
    if(!confirm(`${modes[p.mode]}：${row.item.itemCode} × ${row.qty}\n將轉為負責業務保管待送；客戶訂單不會標為已送貨。`))return;
    const id=button.dataset.operationId||(button.dataset.operationId=lifecycleRecordId());const bs=beginActionButton(button,'交付中…');
    try{await root.commitWarehouseTransfer({id,orderId,itemId,qty:row.qty,handoff:true,expectedWarehouseId:row.warehouseId,expectedPlan:savedRowPlan(row)});delete button.dataset.operationId;await refreshRows(orderId);await loadInventory(true);showActionFeedback('已交付負責業務，保留訂單預留；負責業務送達客戶時再登錄送貨。');}
    catch(err){showActionFeedback('交付未完成：'+err.message,'warning');}finally{endActionButton(button,bs);}
  };
  root.startOrderWarehouseTransfer=async function(orderId,itemId,button){
    const row=transferRequirements(orderWorkQueueCache,warehouseMasterCache,defaultWarehouse()?.id||'',{status:normalizedOrderStatus,incomplete:orderInventorySyncIncomplete,items:normalizedOrderItems,dispatch:itemDispatchState}).find(r=>r.order.id===orderId&&r.item.itemId===itemId);if(!allowed()||!row)return;const p=rowPlan(row);
    if(row.readyQty<row.qty)return alert('此品項尚未全部到貨並打單，暫時不能寄出。');
    try{validatePlan(p,true);}catch(err){return alert(err.message);}
    if(!confirm(`將 ${row.item.itemCode} × ${row.qty} 寄往 ${warehouseName(p.warehouseId)}？\n目的倉確認收貨前，這批貨無法送貨；不會完成客戶訂單。`))return;
    const id=button.dataset.operationId||(button.dataset.operationId=lifecycleRecordId());const bs=beginActionButton(button,'調撥中…');
    try{await root.commitWarehouseTransfer({id,orderId,itemId,qty:row.qty,toWarehouseId:p.warehouseId,expectedWarehouseId:row.warehouseId,expectedPlan:savedRowPlan(row)});delete button.dataset.operationId;await refreshRows(orderId);await root.loadWarehouseTransferQueue(true);await loadInventory(true);root.renderMainTransferRequests?.();showActionFeedback('已出貨至主倉，主倉確認已收貨後可由業務自領。');}
    catch(err){showActionFeedback('調撥未完成：'+err.message,'warning');}finally{endActionButton(button,bs);}
  };
  root.receiveWarehouseTransfer=async function(id,button){
    if(!allowed()||pending.has(id))return;if(!confirm('已點收這筆調撥貨品，確認全部入庫？'))return;
    pending.add(id);const bs=beginActionButton(button,'入庫中…');
    try{const result=await root.commitWarehouseTransferReceipt(id,{onStockCommitted:invalidateWarehouseStockCache});await refreshRows(result.orderId);await refreshAffectedOrderCaches(result.affectedOrderIds||[]);await loadInventory(true);await root.loadWarehouseTransferQueue(true);showActionFeedback(result.orderId?'調撥已入庫，原訂單預留已移到收貨倉庫。':'調撥已入庫，缺貨訂單分配與採購需求已同步。');}
    catch(err){showActionFeedback('調撥收貨未完成：'+err.message,'warning');}finally{pending.delete(id);endActionButton(button,bs);}
  };
})(typeof globalThis!=='undefined'?globalThis:this);

/* All stock/location, lot, reservation and order changes are buffered in one role transaction. */
