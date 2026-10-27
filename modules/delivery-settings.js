/* Saved defaults are copied into the order. Editing a master never rewrites orders. */
(function(root){
  function addresses(value){
    const seen=new Set();return (Array.isArray(value)?value:[]).slice(0,30).map(x=>({id:String(x.id||''),label:String(x.label||'').trim(),contact:String(x.contact||'').trim(),phone:String(x.phone||'').trim(),address:String(x.address||'').trim()})).filter(x=>x.id&&!seen.has(x.id)&&seen.add(x.id));
  }
  function salespersonPlan(person,mainId){const d=person?.deliveryDefaults||{};return {mode:d.mode==='SALES_SHIP'?'SALES_SHIP':'PICKUP',warehouseId:d.mode==='SALES_SHIP'?'':mainId,contact:d.contact||person?.name||'',phone:d.phone||person?.phone||'',address:d.mode==='SALES_SHIP'?d.address||'':'',packages:1,notes:d.notes||''};}
  function editableItem(item){return !item.transferPendingId&&!String(item.warehouseId||'').startsWith('custody-')&&Number(item.deliveredQty||0)-Number(item.returnedQty||0)<Number(item.qty||item.orderedQty||0);}
  const api={addresses,salespersonPlan,editableItem};root.YushinDeliverySettings=api;
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(typeof document==='undefined')return;
  const $=id=>document.getElementById(id);let customerGeneration=0,customerRows=[],customerKey='',changed=false,profileUid='';
  root.resetDeliverySettings=function(){customerGeneration++;customerRows=[];customerKey='';changed=false;profileUid='';personalActor=null;$('deliverySettingsOverlay')?.remove();};
  const previousSet=root.setOrderShippingInstructions;
  const owner=()=>salesList.find(s=>s.uid===(currentUserRole==='purchaser'?$('orderOwnerUid')?.value:currentUser?.uid));
  function replaceRecipient(p){for(const key of ['contact','phone','address'])if($('orderShipping'+key[0].toUpperCase()+key.slice(1)))$('orderShipping'+key[0].toUpperCase()+key.slice(1)).value=p[key]||'';}
  function controls(p){
    const host=$('orderShippingFields');if(!host)return;
    const mode=$('orderShippingMode');mode.innerHTML='<option value="">請選擇交付方式</option><option value="PICKUP">主倉自領</option><option value="SALES_SHIP">寄給我（寄給負責業務）</option><option value="CUSTOMER_SHIP">直接寄客戶</option>';mode.value=['PICKUP','SALES_SHIP','CUSTOMER_SHIP'].includes(p.mode)?p.mode:'';mode.onchange=()=>root.orderDeliveryChoiceChanged();
    const w=$('orderShippingWarehouse');const label=w.closest('label');if(label.firstChild)label.firstChild.textContent='業務領貨地點';label.style.display='none';
    const box=document.createElement('div');box.className='delivery-choice-row logistics-wide';box.innerHTML=`<label>客戶常用收件地址<select id="orderCustomerAddress" onchange="selectOrderCustomerAddress(this.value)"><option value="">本次自行填寫</option></select></label><div><button type="button" class="btn-secondary btn-small" onclick="saveOrderCustomerAddress(this)">加入常用地址</button><button type="button" class="btn-secondary btn-small" onclick="setDefaultOrderCustomerAddress(this)">設為客戶預設地址</button></div><p id="orderAddressStatus" class="inventory-work-status" role="status"></p>`;host.prepend(box);
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
    if((existing&&Object.keys(existing).length)||changed||(currentUserRole==='purchaser'&&!owner()))return;const p=salespersonPlan(owner(),defaultWarehouse()?.id||'');previousSet(p);controls(root.YushinWarehouseLogistics.plan(p));changed=false;
    if($('orderCustomer')?.value&&$('orderShippingMode')?.value==='CUSTOMER_SHIP')root.loadOrderCustomerAddresses();
  };
  root.orderDeliveryOwnerChanged=function(){
    // A different owner must never inherit the previous salesperson's recipient.
    customerGeneration++;changed=false;
    requestedOrderOwnerUid=$('orderOwnerUid')?.value||'';
    const mode=$('orderShippingMode')?.value||'';
    if(mode==='CUSTOMER_SHIP'){changed=true;return;}
    const person=owner();
    const defaults=salespersonPlan(person,defaultWarehouse()?.id||'');
    const p=person?{...defaults,...(mode==='SALES_SHIP'?{mode,warehouseId:'',address:person.deliveryDefaults?.address||''}:{})}:{};
    previousSet(p);controls(root.YushinWarehouseLogistics.plan(p));changed=true;
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
      $('orderAddressStatus').textContent=customerRows.length?'修改本次地址不會覆蓋常用地址。':'此客戶尚無常用地址，可填寫後按「加入常用地址」。';
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
  root.closeDeliverySettings=()=>{customerGeneration++;personalActor=null;$('deliverySettingsOverlay')?.classList.remove('active');};
  root.openSalesDeliveryDefaults=async function(uid){
    if(currentUserRole!=='admin')return;await loadWarehouseMaster();const user=allUsersCache.find(u=>u.uid===uid);if(!user)return;profileUid=uid;const p=salespersonPlan(user,defaultWarehouse()?.id||'');
    overlay(`<h3>${escapeHtml(user.name||user.code||'業務')}・領貨與常用地址</h3><p>供新訂單自動帶入；本次訂單可另外調整。</p><div class="form-grid"><label>領貨方式<select id="salesDeliveryMode"><option value="PICKUP">主倉自行領貨</option><option value="SALES_SHIP">寄到業務地址</option></select></label><label>收件人<input id="salesDeliveryContact" value="${escapeAttr(p.contact)}"></label><label>電話<input id="salesDeliveryPhone" value="${escapeAttr(p.phone)}"></label><label class="logistics-wide">業務收貨地址<input id="salesDeliveryAddress" value="${escapeAttr(p.address)}"></label></div><div class="toolbar"><button onclick="saveSalesDeliveryDefaults(this)">儲存</button><button class="btn-secondary" onclick="closeDeliverySettings()">關閉</button></div>`);$('salesDeliveryMode').value=p.mode;
  };
  root.saveSalesDeliveryDefaults=async function(button){
    if(currentUserRole!=='admin'||!profileUid)return;const uid=profileUid,actor=currentUser.uid;let p;
    try{p=root.YushinWarehouseLogistics.validatePlan({mode:$('salesDeliveryMode').value,contact:$('salesDeliveryContact').value,phone:$('salesDeliveryPhone').value,address:$('salesDeliveryAddress').value},true);}catch(err){return alert(err.message);}
    const bs=beginActionButton(button,'儲存中…');try{await db.collection('users').doc(uid).set({deliveryDefaults:p,updatedAt:new Date().toISOString()},{merge:true});if(currentUser.uid!==actor)return;const user=allUsersCache.find(u=>u.uid===uid);if(user)user.deliveryDefaults=p;applySalesRows(allUsersCache.map(u=>({id:u.uid,...u})));renderAdminSalesTable();root.closeDeliverySettings();showActionFeedback('業務領貨與地址設定已儲存。');}catch(err){showActionFeedback('儲存失敗：'+err.message,'warning');}finally{endActionButton(button,bs);}
  };
  let personalActor=null,personalBusy=false;
  root.openPersonalSettings=async function(){
    const uid=currentUser?.uid,role=currentUserRole;if(!uid)return;
    const generation=++customerGeneration;
    overlay('<h3>個人設定</h3><p role="status">正在讀取設定…</p><button class="btn-secondary" onclick="closeDeliverySettings()">關閉</button>');
    try{
      const snap=await firestoreReadWithTimeout(db.collection('users').doc(uid).get(),'個人設定');
      if(uid!==currentUser?.uid||role!==currentUserRole||generation!==customerGeneration)return;
      if(!snap.exists)throw Error('找不到帳號資料，請聯絡管理員。');
      const user=snap.data(),p=salespersonPlan(user,defaultWarehouse()?.id||'');personalActor={uid,role};
      overlay(`<h3>個人設定</h3><p>${escapeHtml(user.name||'')} · ${escapeHtml(user.code||'')} · ${escapeHtml(user.email||currentUser.email||'')} · ${escapeHtml(user.role||'')}</p><form id="personalSettingsForm" onsubmit="event.preventDefault();savePersonalSettings(this.querySelector('[type=submit]'))"><section><h4>聯絡資料</h4><label>聯絡電話<input id="personalPhone" maxlength="100" value="${escapeAttr(user.phone||'')}"></label><p class="record-reference">儲存後更新系統人員名單與新估價單的聯絡電話，不影響登入驗證電話。收件電話可在下方另外設定。</p></section><section><h4>領貨與寄送</h4><div class="form-grid"><label>預設領貨方式<select id="personalMode"><option value="PICKUP">主倉自領</option><option value="SALES_SHIP">寄給業務</option></select></label><label>收件人<input id="personalContact" maxlength="1000" value="${escapeAttr(p.contact)}"></label><label>收件電話<input id="personalDeliveryPhone" maxlength="1000" value="${escapeAttr(p.phone)}"></label><label class="logistics-wide">業務收件地址<input id="personalAddress" maxlength="1000" value="${escapeAttr(p.address)}"></label></div><p class="record-reference">只供之後的新訂單帶入；既有訂單及客戶地址不會變更。</p></section><p id="personalSettingsStatus" role="status"></p><div class="toolbar"><button type="submit">儲存設定</button><button type="button" class="btn-secondary" onclick="closeDeliverySettings()">關閉</button><button type="button" class="btn-secondary" onclick="closeDeliverySettings();openChangePasswordModal()">修改密碼</button></div></form>`);$('personalMode').value=p.mode;
    }catch(err){if(uid===currentUser?.uid&&generation===customerGeneration)overlay('<h3>個人設定</h3><p role="alert">設定讀取失敗：'+escapeHtml(err.message)+'</p><button class="btn-secondary" onclick="openPersonalSettings()">重試</button><button class="btn-secondary" onclick="closeDeliverySettings()">關閉</button>');}
  };
  root.savePersonalSettings=async function(button){
    const actor=personalActor;if(personalBusy||!actor||actor.uid!==currentUser?.uid||actor.role!==currentUserRole)return;
    let p;try{p=root.YushinWarehouseLogistics.validatePlan({mode:$('personalMode').value,contact:$('personalContact').value,phone:$('personalDeliveryPhone').value,address:$('personalAddress').value},true);}catch(err){$('personalSettingsStatus').textContent=err.message;return;}
    const generation=customerGeneration,phone=$('personalPhone').value.trim();if(phone.length>100)return;
    if(!confirm('請核對個人聯絡電話：'+(phone||'（未填寫）')+'\n領貨設定：\n'+(p.mode==='PICKUP'?'主倉自領':[p.contact,p.phone,p.address].join('\n'))+'\n聯絡電話會更新人員資料；領貨設定只套用至之後的新訂單。'))return;
    personalBusy=true;const bs=beginActionButton(button,'儲存中…');
    try{await db.collection('users').doc(actor.uid).update({phone,deliveryDefaults:p,updatedAt:firebase.firestore.FieldValue.serverTimestamp()});
      if(actor.uid!==currentUser?.uid||actor.role!==currentUserRole)return;
      for(const list of [allUsersCache,salesList]){const user=list.find(u=>(u.uid||u.id)===actor.uid);if(user)Object.assign(user,{phone,deliveryDefaults:p});}
      currentUserPhone=phone;
      // The login screen can render from this cache before Firestore responds.
      // Keep the saved contact phone consistent after refresh, without touching Auth.
      const cached=typeof readCachedUserProfile==='function'?readCachedUserProfile(actor.uid):null;
      if(cached&&typeof writeCachedUserProfile==='function')writeCachedUserProfile(actor.uid,{...cached,phone});
      if(generation===customerGeneration&&$('personalSettingsStatus'))$('personalSettingsStatus').textContent='設定已儲存；既有訂單維持原設定。';
    }catch(err){if(actor.uid===currentUser?.uid&&generation===customerGeneration&&$('personalSettingsStatus'))$('personalSettingsStatus').textContent=err.code==='permission-denied'?'個人設定儲存失敗：請通知管理員同步最新權限設定後重試；目前資料尚未變更。':'個人設定儲存失敗：請檢查連線後重試；目前資料尚未變更。';}finally{personalBusy=false;endActionButton(button,bs);}
  };
  root.renderOrderDeliverySettingsButton=function(order){
    let summary=$('orderDeliveryRecipientSummary');
    if(!summary){summary=document.createElement('div');summary.id='orderDeliveryRecipientSummary';summary.className='delivery-settings-section';const title=$('deliveryModalTitle');title?.parentElement.insertBefore(summary,title.nextSibling);}
    summary.innerHTML=normalizedOrderItems(order).map(item=>{
      const p=root.YushinWarehouseLogistics.plan(item.deliveryPlan||order.shippingInstructions||{});
      const recipient=p.mode==='PICKUP'?'':`<br>收件人：${escapeHtml(p.contact||'未填寫')}｜聯絡電話：${escapeHtml(p.phone||'未填寫')}<br>完整收件地址：${escapeHtml(p.address||'未填寫；請補齊後再寄送')}`;
      return `<p>${escapeHtml(item.itemCode||item.itemName||'品項')}｜${escapeHtml(root.YushinWarehouseLogistics.modes[p.mode]||'未設定交付方式')}${recipient}</p>`;
    }).join('');
    let button=$('orderDeliverySettingsButton');if(!button){button=document.createElement('button');button.id='orderDeliverySettingsButton';button.type='button';button.className='btn-secondary';const title=$('deliveryModalTitle');title?.parentElement.insertBefore(button,title.nextSibling);}button.textContent='修改交付方式／地址';button.style.display=normalizedOrderStatus(order)==='normal'&&(currentUserRole==='admin'||order.ownerUid===currentUser?.uid||canReceiveInventoryCapability())&&root.YushinOrderCommercialDetails.beforeReceipt(order)&&normalizedOrderItems(order).some(editableItem)?'':'none';button.onclick=()=>root.openOrderDeliverySettings(order.id);
  };
  root.openOrderDeliverySettings=function(orderId){const order=ordersCache.find(o=>o.id===orderId);if(!order||!root.YushinOrderCommercialDetails.beforeReceipt(order))return;const items=normalizedOrderItems(order).filter(editableItem);overlay(`<h3>修改交付設定</h3><p>第一批到貨前可修改交付設定。已交付負責業務或調撥途中的品項須由倉管處理。</p><div class="table-wrap"><table><thead><tr><th>品項</th><th>交付方式</th><th>操作</th></tr></thead><tbody>${items.map(i=>`<tr><td>${escapeHtml(i.itemCode)}<br>${escapeHtml(i.itemName)}</td><td>${escapeHtml(root.YushinWarehouseLogistics.modes[(i.deliveryPlan||order.shippingInstructions||{}).mode]||'負責業務自取／親送')}</td><td><button onclick="closeDeliverySettings();openWarehouseDeliveryPlan(${inlineJsValue(orderId)},${inlineJsValue(i.itemId)})">修改</button></td></tr>`).join('')}</tbody></table></div><button class="btn-secondary" onclick="closeDeliverySettings()">關閉</button>`);};
})(typeof globalThis!=='undefined'?globalThis:this);
