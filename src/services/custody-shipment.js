// Owner-Custody customer shipment. This UI has no direct stock writer; only
// the authenticated V3 Callable may mutate the original reservation ledger.
function v3CustodyShipmentKey(orderId,itemId){
 return 'v3-custody-shipment:'+encodeURIComponent(currentUser?.uid||'')+':'+encodeURIComponent(orderId)+':'+encodeURIComponent(itemId);
}
function pendingV3CustodyShipment(orderId,itemId){
 if(typeof sessionStorage==='undefined')return null;
 const raw=sessionStorage.getItem(v3CustodyShipmentKey(orderId,itemId));
 if(!raw)return null;
 try{
  const value=JSON.parse(raw);
  if(!value||value.orderId!==orderId||value.itemId!==itemId
    ||value.actorUid!==currentUser?.uid||value.actorRole!==currentUserRole
    ||!value.operationId||!value.syncAttemptId)throw Error('identity');
  return value;
 }catch(_){throw Error('前次保管實際出貨結果未確認，請以原帳號與原操作編號核對。');}
}
function v3CustodyShipmentTransport(){
 const local=host=>host==='localhost'||host==='127.0.0.1';
 if(globalThis.YUSHIN_V3_CUSTODY_SHIPMENT_EMULATOR!==true
   ||!local(globalThis.location?.hostname)||typeof firebase==='undefined'
   ||!firebase.auth||!firebase.functions||typeof db==='undefined')
  throw Error('V3 保管實際出貨只在隔離 Emulator 啟用，禁止改用舊交易。');
 const auth=firebase.auth(),functions=firebase.app().functions('asia-east1');
 if(firebase.app().options?.projectId!=='demo-yushin'
   ||auth.app?.options?.projectId!=='demo-yushin'
   ||functions.app?.options?.projectId!=='demo-yushin'
   ||db.app?.options?.projectId!=='demo-yushin'
   ||!local(auth.emulatorConfig?.host)||auth.emulatorConfig?.port!==9099)
  throw Error('V3 保管實際出貨的 Auth／Functions／Firestore 專案或 Emulator 不一致。');
 const uid=currentUser?.uid,role=currentUserRole;
 const check=()=>{
  if(!uid||currentUser?.uid!==uid||auth.currentUser?.uid!==uid||currentUserRole!==role
    ||!['admin','sales','engineer'].includes(role)
    ||!canManageOrderLifecycleCapability()||!canEditPage('orders.list'))
   throw Error('登入身分或保管實際出貨權限已變更。');
 };
 check();return{uid,role,functions,check};
}
async function commitV3CustodyShipment(input){
 const {uid,role,functions,check}=v3CustodyShipmentTransport();
 const {orderId,itemId,qty,date,notes,operationId,expectedPlan}=input;
 if(typeof orderId!=='string'||!orderId||typeof itemId!=='string'||!itemId
   ||!/^[A-Za-z0-9_-]{12,96}$/.test(operationId||'')
   ||!Number.isSafeInteger(qty)||qty<=0
   ||typeof date!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)
   ||!Number.isFinite(Date.parse(date+'T00:00:00Z'))
   ||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date
   ||typeof notes!=='string'||notes.length>1000)
  throw Error('V3 保管出貨識別、數量、日期或備註不正確。');
 const plan=globalThis.YushinWarehouseLogistics.validatePlan(expectedPlan,true);
 if(plan.mode!=='CUSTOMER_SHIP')throw Error('請填寫實際送至客戶的收件人及地址。');
 const key=v3CustodyShipmentKey(orderId,itemId);
 let frozen=pendingV3CustodyShipment(orderId,itemId);
 if(frozen){
  if(frozen.operationId!==operationId||frozen.quantity!==qty||frozen.date!==date
    ||frozen.notes!==notes||JSON.stringify(frozen.expectedPlan)!==JSON.stringify(plan))
   throw Error('前次保管出貨尚未確認，請使用原操作編號與原收件資訊重試。');
 }else{
  const snap=await db.collection('orders').doc(orderId).get({source:'server'});check();
  if(!snap.exists)throw Error('保管訂單不存在。');
  const order=snap.data(),item=order.items?.find(row=>row.itemId===itemId);
  if(!v3CustodyShipmentItems(order).length||!item||item.warehouseId!=='custody-'+order.ownerUid
    ||!item.custodyTransferId||['sales','engineer'].includes(role)&&order.ownerUid!==uid
    ||order.inventoryReservationStatus!=='completed'||!order.inventoryReservationAttemptId)
   throw Error('訂單不具備可驗證的 V3 業務保管來源。');
  const ledger=await db.collection('inventoryReservations').doc(orderId+'__'+itemId).get({source:'server'});check();
  if(!ledger.exists||ledger.data().locationSchemaVersion!==3
    ||ledger.data().custodyTransferId!==item.custodyTransferId)
   throw Error('原業務保管預留來源尚未完成。');
  frozen={orderId,itemId,warehouseId:item.warehouseId,quantity:qty,
   date,notes,operationId,syncAttemptId:order.inventoryReservationAttemptId,expectedPlan:plan,
   actorUid:uid,actorRole:role};
  sessionStorage.setItem(key,JSON.stringify(frozen));
 }
 check();functions.useEmulator('127.0.0.1',5001);
 const {actorUid,actorRole,...payload}=frozen;
 const response=await functions.httpsCallable('shipV3CustodyItem')(payload);check();
 const result=response?.data;
 if(!['applied','already-applied'].includes(result?.status)||result.orderId!==orderId
   ||result.itemId!==itemId||result.warehouseId!==frozen.warehouseId
   ||result.qty!==qty||result.movementId!=='location-ship-'+operationId)
  throw Error('V3 保管出貨回覆無法確認，請以原操作編號恢復。');
 const refreshed=await db.collection('orders').doc(orderId).get({source:'server'});check();
 const order=refreshed.exists?refreshed.data():null;
 const proof=(order?.warehouseShipmentRecords||[]).find(row=>row.id===operationId);
 if(!proof||proof.itemId!==itemId||proof.warehouseId!==frozen.warehouseId
   ||proof.qty!==qty||proof.date!==date||String(proof.notes||'')!==notes
   ||proof.custodyTransferId!==order?.items?.find(row=>row.itemId===itemId)?.custodyTransferId
   ||proof.movementId!=='location-ship-'+operationId
   ||JSON.stringify(globalThis.YushinWarehouseLogistics.validatePlan(proof.deliveryPlan,true))!==JSON.stringify(plan))
  throw Error('V3 保管出貨結果尚未從權威訂單核對，保留原操作編號。');
 sessionStorage.removeItem(key);
 return order;
}
window.resumeV3CustodyShipment=async function(orderId,itemId){
 const prior=pendingV3CustodyShipment(orderId,itemId);
 if(!prior)throw Error('沒有待恢復的保管出貨。');
 return commitV3CustodyShipment({orderId,itemId,qty:prior.quantity,date:prior.date,
  notes:prior.notes,operationId:prior.operationId,expectedPlan:prior.expectedPlan});
};
function v3CustodyShipmentItems(order){
 const items=order?.items,custody='custody-'+order?.ownerUid;
 if(!Array.isArray(items)||!items.length||items.length>5
   ||(order.returnRecords||[]).length||(order.deliveryRecords||[]).length)return [];
 return items.every(item=>item?.custodyTransferId&&item.warehouseId===custody
   &&!item.transferPendingId&&(item.fulfillmentType||'WAREHOUSE')==='WAREHOUSE'
   &&String(item.productType||item.type||'').toUpperCase()!=='SERVICE')?items:[];
}
window.openV3CustodyShipment=async function(orderId){
 const order=ordersCache.find(row=>row.id===orderId),items=v3CustodyShipmentItems(order);
 if(!items.length)return;
 try{
  const pending=items.find(item=>pendingV3CustodyShipment(orderId,item.itemId));
  if(pending){
   const saved=await window.resumeV3CustodyShipment(orderId,pending.itemId);
   const index=ordersCache.findIndex(row=>row.id===orderId);
   if(index>=0)ordersCache[index]={id:orderId,...saved};
   renderOrdersList();return;
  }
  v3CustodyShipmentTransport();
 }catch(error){alert('保管出貨無法繼續：'+error.message);return;}
 const candidates=items.filter(item=>Number.isSafeInteger(item.reservedQty)&&item.reservedQty>0);
 if(!candidates.length){alert('此訂單已無待保管出貨品項。');return;}
 const first=candidates[0],remaining=first.reservedQty;
 const modal=document.createElement('dialog');modal.className='modal';
 modal.innerHTML=`<form method="dialog" class="modal-content" style="max-width:420px">
  <h3>業務保管實際出貨</h3><p>訂單：${escapeHtml(order.orderNo||orderId)}</p>
  <label>出貨品項<select name="itemId" required>${candidates.map(item=>
   `<option value="${escapeAttr(item.itemId)}">${escapeHtml(item.itemName||item.itemCode||item.itemId)}・待出貨 ${item.reservedQty}</option>`).join('')}</select></label>
  <label>出貨數量<input name="qty" type="number" min="1" max="${remaining}" step="1" value="${remaining}" required></label>
  <label>出貨日期<input name="date" type="date" value="${escapeAttr(typeof localDateString==='function'?localDateString():new Date().toISOString().slice(0,10))}" required></label>
  <label>客戶收件人<input name="contact" maxlength="1000" value="${escapeAttr(order.customerName||'')}" required></label>
  <label>聯絡電話<input name="phone" maxlength="1000" value="${escapeAttr(order.customerPhone||'')}" required></label>
  <label>客戶收件地址<input name="address" maxlength="1000" value="${escapeAttr(order.customerAddress||'')}" required></label>
  <label>備註<textarea name="notes" maxlength="1000"></textarea></label>
  <p>此步驟僅扣保管實貨；客戶送達須另外確認。</p>
  <div class="toolbar"><button type="button" data-action="cancel" class="btn-secondary">取消</button>
  <button type="submit">確認已實際出貨</button></div><p role="status" data-role="status"></p>
 </form>`;
 document.body.appendChild(modal);
 const form=modal.querySelector('form'),save=form.querySelector('button[type="submit"]');
 const itemChoice=form.querySelector('select[name="itemId"]'),quantity=form.querySelector('input[name="qty"]');
 itemChoice.addEventListener('change',()=>{
  const selected=candidates.find(item=>item.itemId===itemChoice.value);
  if(selected){quantity.max=String(selected.reservedQty);quantity.value=String(selected.reservedQty);}
 });
 modal.querySelector('[data-action="cancel"]').addEventListener('click',()=>modal.close());
 modal.addEventListener('close',()=>modal.remove(),{once:true});
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(save.disabled)return;
  save.disabled=true;
  const values=new FormData(form),qty=Number(values.get('qty'));
  const selected=candidates.find(item=>item.itemId===String(values.get('itemId')||''));
  const date=String(values.get('date')||''),notes=String(values.get('notes')||'');
  const expectedPlan={mode:'CUSTOMER_SHIP',contact:String(values.get('contact')||''),
   phone:String(values.get('phone')||''),address:String(values.get('address')||''),
   warehouseId:'',packages:1,notes:''};
  const operationId='custody_ship_'+crypto.randomUUID().replaceAll('-','_');
  try{
   if(!selected||!Number.isSafeInteger(qty)||qty<=0||qty>selected.reservedQty)
    throw Error('請選擇有效的保管品項與出貨數量。');
   const saved=await commitV3CustodyShipment({orderId,itemId:selected.itemId,qty,date,notes,
    operationId,expectedPlan});
   const index=ordersCache.findIndex(row=>row.id===orderId);
   if(index>=0)ordersCache[index]={id:orderId,...saved};
   modal.close();renderOrdersList();
  }catch(error){form.querySelector('[data-role="status"]').textContent='結果未確認：'+error.message;
   // If the Callable may have run, the original intent is frozen. A later
   // click must resume it from the order button, never generate a new debit.
  }finally{save.disabled=false;}
 });
 modal.showModal();
};
