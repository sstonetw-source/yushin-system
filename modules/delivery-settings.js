/* Saved defaults are copied into the order. Editing a master never rewrites orders. */
(function(root){
  function addresses(value){
    const seen=new Set();return (Array.isArray(value)?value:[]).slice(0,30).map(x=>({id:String(x.id||''),label:String(x.label||'').trim(),contact:String(x.contact||'').trim(),phone:String(x.phone||'').trim(),address:String(x.address||'').trim()})).filter(x=>x.id&&!seen.has(x.id)&&seen.add(x.id));
  }
  function salespersonPlan(person,mainId){const d=person?.deliveryDefaults||{};return {mode:d.mode==='SALES_SHIP'?'SALES_SHIP':'PICKUP',warehouseId:d.mode==='SALES_SHIP'?'':mainId,contact:d.contact||person?.name||'',phone:d.phone||person?.phone||'',address:d.mode==='SALES_SHIP'?d.address||'':'',packages:1,notes:d.notes||''};}
  function editableItem(item){return !item.transferPendingId&&!String(item.warehouseId||'').startsWith('custody-')&&Number(item.deliveredQty||0)-Number(item.returnedQty||0)<Number(item.qty||item.orderedQty||0)&&(item.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP';}
  const api={addresses,salespersonPlan,editableItem};root.YushinDeliverySettings=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(typeof document==='undefined')return;
  const $=id=>document.getElementById(id);let customerGeneration=0,customerRows=[],customerKey='',changed=false,profileUid='';
  root.resetDeliverySettings=function(){customerGeneration++;customerRows=[];customerKey='';changed=false;profileUid='';$('deliverySettingsOverlay')?.remove();};
  const previousSet=root.setOrderShippingInstructions;
  const owner=()=>salesList.find(s=>s.uid===($('orderOwnerUid')?.value||currentUser?.uid))||salesList.find(s=>s.uid===currentUser?.uid);
  function replaceRecipient(p){for(const key of ['contact','phone','address'])if($('orderShipping'+key[0].toUpperCase()+key.slice(1)))$('orderShipping'+key[0].toUpperCase()+key.slice(1)).value=p[key]||'';}
  function controls(p){
    const host=$('orderShippingFields');if(!host)return;
    const mode=$('orderShippingMode');mode.innerHTML='<option value="">請選擇交付方式</option><option value="PICKUP">主倉自領</option><option value="SALES_SHIP">寄給我</option><option value="CUSTOMER_SHIP">直接寄客戶</option>';mode.value=['PICKUP','SALES_SHIP','CUSTOMER_SHIP'].includes(p.mode)?p.mode:'';mode.onchange=()=>root.orderDeliveryChoiceChanged();
    const w=$('orderShippingWarehouse');const label=w.closest('label');if(label.firstChild)label.firstChild.textContent='業務領貨地點';label.style.display='none';
    const box=document.createElement('div');box.className='delivery-choice-row logistics-wide';box.innerHTML=`<label>客戶常用收件地址<select id="orderCustomerAddress" onchange="selectOrderCustomerAddress(this.value)"><option value="">本次自行填寫</option></select></label><div><button type="button" class="btn-secondary btn-small" onclick="saveOrderCustomerAddress(this)">記住此客戶地址</button><button type="button" class="btn-secondary btn-small" onclick="setDefaultOrderCustomerAddress(this)">儲存並設為預設</button></div><p id="orderAddressStatus" class="inventory-work-status" role="status"></p>`;host.prepend(box);
    host.oninput=e=>{if(e.target.id!=='orderCustomerAddress')changed=true;};
    root.orderDeliveryChoiceChanged(false);
  }
  root.setOrderShippingInstructions=function(value={}){customerGeneration++;customerRows=[];customerKey='';changed=Object.keys(value).length>0;previousSet(value);controls(root.YushinWarehouseLogistics.plan(value));};
  root.orderShippingInstructions=function(){
    const p={};for(const key of ['contact','phone','address','notes'])p[key]=$('orderShipping'+key[0].toUpperCase()+key.slice(1))?.value||'';
    p.mode=$('orderShippingMode')?.value||'';p.warehouseId=p.mode==='PICKUP'?defaultWarehouse()?.id||'':'';
    return root.YushinWarehouseLogistics.plan(p);
  };
  root.orderDeliveryChoiceChanged=function(fill=true){
    const mode=$('orderShippingMode')?.value||'',customer=mode==='CUSTOMER_SHIP',pickup=mode==='PICKUP';
    $('orderCustomerAddress')?.closest('label').style.setProperty('display',customer?'':'none');
    $('orderShippingWarehouse')?.closest('label').style.setProperty('display','none');
    const remember=$('orderCustomerAddress')?.closest('.delivery-choice-row')?.querySelector('div');if(remember)remember.style.display=customer?'':'none';
    for(const key of ['Contact','Phone','Address'])$('orderShipping'+key)?.closest('label').style.setProperty('display',pickup?'none':'');
    if(fill){customerGeneration++;changed=true;if(customer){replaceRecipient({});root.loadOrderCustomerAddresses();}else{const p=salespersonPlan(owner(),defaultWarehouse()?.id||'');const d=owner()?.deliveryDefaults||{};replaceRecipient(mode==='SALES_SHIP'?{...p,address:d.address||''}:{});$('orderShippingWarehouse').value=defaultWarehouse()?.id||'';}}
  };
  root.initializeOrderDeliveryDefaults=function(existing){
    if((existing&&Object.keys(existing).length)||changed)return;const p=salespersonPlan(owner(),defaultWarehouse()?.id||'');previousSet(p);controls(root.YushinWarehouseLogistics.plan(p));changed=false;
    if($('orderCustomer')?.value&&$('orderShippingMode')?.value==='CUSTOMER_SHIP')root.loadOrderCustomerAddresses();
  };
  root.orderDeliveryCustomerTyping=function(){customerGeneration++;customerRows=[];customerKey='';if($('orderCustomerAddress'))$('orderCustomerAddress').innerHTML='<option value="">本次自行填寫</option>';if($('orderShippingMode')?.value==='CUSTOMER_SHIP')replaceRecipient({});if($('orderAddressStatus'))$('orderAddressStatus').textContent='選定客戶後讀取常用地址。';};
  root.loadOrderCustomerAddresses=async function(){
    const name=$('orderCustomer')?.value.trim();if(!name)return;const key=customerIdForName(name),generation=++customerGeneration,uid=currentUser?.uid;
    const fingerprint=JSON.stringify(root.orderShippingInstructions());$('orderAddressStatus').textContent='讀取常用地址…';
    try{const snap=await firestoreReadWithTimeout(db.collection('customers').doc(key).get(),'客戶收件地址');
      if(generation!==customerGeneration||uid!==currentUser?.uid||key!==customerIdForName($('orderCustomer')?.value||''))return;
      const data=snap.exists?snap.data():{};customerRows=data.active!==false?addresses(data.shippingAddresses):[];customerKey=key;
      $('orderCustomerAddress').innerHTML='<option value="">本次自行填寫</option>'+customerRows.map(a=>`<option value="${escapeAttr(a.id)}">${escapeHtml(a.label||a.contact)}｜${escapeHtml(a.address)}</option>`).join('');
      if($('orderShippingMode').value==='CUSTOMER_SHIP'&&fingerprint===JSON.stringify(root.orderShippingInstructions())&&!['contact','phone','address'].some(key=>root.orderShippingInstructions()[key])){const preferred=customerRows.find(a=>a.id===data.defaultShippingAddressId);if(preferred){$('orderCustomerAddress').value=preferred.id;replaceRecipient(preferred);}}
      $('orderAddressStatus').textContent=customerRows.length?'修改本次地址不會覆蓋常用地址。':'此客戶尚無常用地址，可填寫後按「記住此客戶地址」。';
    }catch(err){if(generation===customerGeneration)$('orderAddressStatus').textContent='常用地址讀取失敗：'+err.message+'；可自行填寫本次地址。';}
  };
  root.selectOrderCustomerAddress=function(id){const a=customerRows.find(x=>x.id===id);if(a)replaceRecipient(a);changed=true;customerGeneration++;};
  async function saveAddress(button,setDefault){
    if(!hasBusinessCapability()&&currentUserRole!=='admin'&&currentUserRole!=='purchaser')return;
    const name=$('orderCustomer')?.value.trim();if(!name)return alert('請先填寫客戶名稱。');const key=customerIdForName(name),uid=currentUser?.uid;let p;
    try{p=root.YushinWarehouseLogistics.validatePlan({...root.orderShippingInstructions(),mode:'CUSTOMER_SHIP'},true);}catch(err){return alert(err.message);}
    const id=$('orderCustomerAddress')?.value||lifecycleRecordId(),bs=beginActionButton(button,'儲存中…');
    try{await runRoleTransaction(async tx=>{const ref=db.collection('customers').doc(key),snap=await tx.get(ref),data=snap.exists?snap.data():{},list=addresses(data.shippingAddresses);if(uid!==currentUser?.uid)throw Error('登入身分已變更。');if(!list.some(a=>a.id===id)&&list.length>=30)throw Error('每個客戶最多 30 個常用地址。');
      const a={id,label:p.contact,contact:p.contact,phone:p.phone,address:p.address};const next=[...list.filter(x=>x.id!==id),a];tx.set(ref,{customerId:key,name,active:data.active!==false,shippingAddresses:next,defaultShippingAddressId:setDefault||!data.defaultShippingAddressId?id:data.defaultShippingAddressId,updatedAt:new Date().toISOString()},{merge:true});});
      if(uid===currentUser?.uid&&key===customerIdForName($('orderCustomer')?.value||'')){await root.loadOrderCustomerAddresses();$('orderCustomerAddress').value=id;$('orderAddressStatus').textContent=setDefault?'此地址已設為客戶預設收件地址。':'常用地址已記住；既有訂單不會跟著變更。';}
    }catch(err){showActionFeedback('地址儲存失敗：'+err.message,'warning');}finally{endActionButton(button,bs);}
  }
  root.saveOrderCustomerAddress=button=>saveAddress(button,false);root.setDefaultOrderCustomerAddress=button=>saveAddress(button,true);
  function overlay(html){let el=$('deliverySettingsOverlay');if(!el){el=document.createElement('div');el.id='deliverySettingsOverlay';el.className='eq-modal-overlay no-print';document.body.appendChild(el);}el.innerHTML='<div class="eq-modal-box warehouse-logistics-modal">'+html+'</div>';el.classList.add('active');}
  root.closeDeliverySettings=()=>{$('deliverySettingsOverlay')?.classList.remove('active');};
  root.openSalesDeliveryDefaults=async function(uid){
    if(currentUserRole!=='admin')return;await loadWarehouseMaster();const user=allUsersCache.find(u=>u.uid===uid);if(!user)return;profileUid=uid;const p=salespersonPlan(user,defaultWarehouse()?.id||'');
    overlay(`<h3>${escapeHtml(user.name||user.code||'業務')}・領貨與常用地址</h3><p>供新訂單自動帶入；本次訂單可另外調整。</p><div class="form-grid"><label>領貨方式<select id="salesDeliveryMode"><option value="PICKUP">主倉自行領貨</option><option value="SALES_SHIP">寄到業務地址</option></select></label><label>收件人<input id="salesDeliveryContact" value="${escapeAttr(p.contact)}"></label><label>電話<input id="salesDeliveryPhone" value="${escapeAttr(p.phone)}"></label><label class="logistics-wide">業務收貨地址<input id="salesDeliveryAddress" value="${escapeAttr(p.address)}"></label></div><div class="toolbar"><button onclick="saveSalesDeliveryDefaults(this)">儲存</button><button class="btn-secondary" onclick="closeDeliverySettings()">關閉</button></div>`);$('salesDeliveryMode').value=p.mode;
  };
  root.saveSalesDeliveryDefaults=async function(button){
    if(currentUserRole!=='admin'||!profileUid)return;const uid=profileUid,actor=currentUser.uid;let p;
    try{p=root.YushinWarehouseLogistics.validatePlan({mode:$('salesDeliveryMode').value,contact:$('salesDeliveryContact').value,phone:$('salesDeliveryPhone').value,address:$('salesDeliveryAddress').value},true);}catch(err){return alert(err.message);}
    const bs=beginActionButton(button,'儲存中…');try{await db.collection('users').doc(uid).set({deliveryDefaults:p,updatedAt:new Date().toISOString()},{merge:true});if(currentUser.uid!==actor)return;const user=allUsersCache.find(u=>u.uid===uid);if(user)user.deliveryDefaults=p;applySalesRows(allUsersCache.map(u=>({id:u.uid,...u})));renderAdminSalesTable();root.closeDeliverySettings();showActionFeedback('業務領貨與地址設定已儲存。');}catch(err){showActionFeedback('儲存失敗：'+err.message,'warning');}finally{endActionButton(button,bs);}
  };
  root.renderOrderDeliverySettingsButton=function(order){
    let button=$('orderDeliverySettingsButton');if(!button){button=document.createElement('button');button.id='orderDeliverySettingsButton';button.type='button';button.className='btn-secondary';const title=$('deliveryModalTitle');title?.parentElement.insertBefore(button,title.nextSibling);}button.textContent='修改交付方式／地址';button.style.display=normalizedOrderStatus(order)==='normal'&&(currentUserRole==='admin'||order.ownerUid===currentUser?.uid||canReceiveInventoryCapability())&&normalizedOrderItems(order).some(editableItem)?'':'none';button.onclick=()=>root.openOrderDeliverySettings(order.id);
  };
  root.openOrderDeliverySettings=function(orderId){const order=ordersCache.find(o=>o.id===orderId);if(!order)return;const items=normalizedOrderItems(order).filter(editableItem);overlay(`<h3>修改交付設定</h3><p>尚未交付的品項可修改，到貨後仍可調整。已交付業務或調撥途中的品項須由倉管處理。</p><div class="table-wrap"><table><thead><tr><th>品項</th><th>交付方式</th><th>操作</th></tr></thead><tbody>${items.map(i=>`<tr><td>${escapeHtml(i.itemCode)}<br>${escapeHtml(i.itemName)}</td><td>${escapeHtml(root.YushinWarehouseLogistics.modes[(i.deliveryPlan||order.shippingInstructions||{}).mode]||'業務自取／親送')}</td><td><button onclick="closeDeliverySettings();openWarehouseDeliveryPlan(${inlineJsValue(orderId)},${inlineJsValue(i.itemId)})">修改</button></td></tr>`).join('')}</tbody></table></div><button class="btn-secondary" onclick="closeDeliverySettings()">關閉</button>`);};
})(typeof globalThis!=='undefined'?globalThis:this);
