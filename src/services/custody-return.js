// Emulator-only customer return into the original owner's V3 Custody lot.
// Inventory, lot, reservation and cost authority all remain in one Callable.
function v3CustodyReturnKey(orderId,itemId){
 return 'v3-custody-return:'+encodeURIComponent(currentUser?.uid||'')+':'+encodeURIComponent(orderId)+':'+encodeURIComponent(itemId);
}
function unresolvedV3CustodyReturnExists(orderId,itemId){
 try{return typeof sessionStorage!=='undefined'&&sessionStorage.getItem(v3CustodyReturnKey(orderId,itemId))!==null;}
 catch(_){return false;}
}
function pendingV3CustodyReturn(orderId,itemId){
 if(typeof sessionStorage==='undefined')return null;
 const raw=sessionStorage.getItem(v3CustodyReturnKey(orderId,itemId));
 if(!raw)return null;
 try{
  const value=JSON.parse(raw);
  if(!value||value.orderId!==orderId||value.itemId!==itemId
    ||value.actorUid!==currentUser?.uid||value.actorRole!==currentUserRole
    ||!value.operationId||!value.syncAttemptId||!Array.isArray(value.selections))throw Error('identity');
  return value;
 }catch(_){throw Error('前次保管退貨實收結果未確認，請以原帳號與原操作編號核對。');}
}
function v3CustodyReturnTransport(){
 const local=host=>host==='localhost'||host==='127.0.0.1';
 if(globalThis.YUSHIN_V3_CUSTODY_RETURN_EMULATOR!==true
   ||!local(globalThis.location?.hostname)||typeof firebase==='undefined'
   ||!firebase.auth||!firebase.functions||typeof db==='undefined')
  throw Error('V3 業務保管退貨只在隔離 Emulator 啟用，不可改用舊前端入庫。');
 const auth=firebase.auth(),functions=firebase.app().functions('asia-east1');
 if(firebase.app().options?.projectId!=='demo-yushin'
   ||auth.app?.options?.projectId!=='demo-yushin'
   ||functions.app?.options?.projectId!=='demo-yushin'
   ||db.app?.options?.projectId!=='demo-yushin'
   ||!local(auth.emulatorConfig?.host)||auth.emulatorConfig?.port!==9099)
  throw Error('V3 業務保管退貨的 Auth／Functions／Firestore 專案或 Emulator 不一致。');
 const uid=currentUser?.uid,role=currentUserRole;
 const check=()=>{
  if(!uid||currentUser?.uid!==uid||auth.currentUser?.uid!==uid||currentUserRole!==role
    ||!['admin','sales','engineer'].includes(role)
    ||!canManageOrderLifecycleCapability()||!canEditPage('orders.list'))
   throw Error('登入身分或保管退貨權限已變更。');
 };
 check();return{uid,role,functions,check};
}
function v3CustodyReturnCandidates(order){
 if(!order||order.items?.length!==1||!Array.isArray(order.warehouseShipmentRecords)
   ||!Array.isArray(order.deliveryRecords)||!Array.isArray(order.returnRecords)
   ||order.returnRecords.length||(order.returnRequests||[]).length||order.returnPending===true)
  return [];
 const item=order.items[0],custody='custody-'+order.ownerUid;
 if(!item.custodyTransferId||item.warehouseId!==custody
   ||!['active','normal'].includes(order.status)
   ||!['',undefined,'normal','active'].includes(order.orderStatus))return [];
 return order.warehouseShipmentRecords.flatMap(shipment=>{
  if(shipment.itemId!==item.itemId||shipment.warehouseId!==custody
    ||shipment.custodyTransferId!==item.custodyTransferId)return [];
  const delivered=order.deliveryRecords.filter(row=>row.shipmentId===shipment.id)
   .reduce((total,row)=>total+Number(row.qty||0),0);
  if(!Number.isSafeInteger(delivered)||delivered<=0)return [];
  return (shipment.lotAllocations||[]).filter(row=>Number.isSafeInteger(row.qty)&&row.qty>0)
   .map(row=>({shipmentId:shipment.id,lotId:row.lotId,lotNo:row.lotNo||'',
    expiryDate:row.expiryDate||'',maxQty:Math.min(delivered,row.qty)}));
 });
}
async function commitV3CustodyReturn(input){
 const {uid,role,functions,check}=v3CustodyReturnTransport();
 const {orderId,itemId,shipmentId,lotId,qty,date,reason,operationId}=input;
 if(typeof orderId!=='string'||!orderId||typeof itemId!=='string'||!itemId
   ||typeof shipmentId!=='string'||!shipmentId||typeof lotId!=='string'||!lotId
   ||!/^[A-Za-z0-9_-]{12,96}$/.test(operationId||'')
   ||!Number.isSafeInteger(qty)||qty<=0
   ||typeof date!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)
   ||!Number.isFinite(Date.parse(date+'T00:00:00Z'))
   ||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date
   ||typeof reason!=='string'||!reason.trim()||reason.length>1000)
  throw Error('保管退貨的來源、數量、日期、原因或操作識別碼不正確。');
 const key=v3CustodyReturnKey(orderId,itemId);
 let frozen=pendingV3CustodyReturn(orderId,itemId);
 if(frozen){
  if(frozen.operationId!==operationId||frozen.shipmentId!==shipmentId||frozen.selections.length!==1
    ||frozen.selections[0].lotId!==lotId||frozen.selections[0].qty!==qty
    ||frozen.date!==date||frozen.reason!==reason.trim())
   throw Error('前次保管退貨尚未確認，只能依原操作編號與原批次重新查核。');
 }else{
  const snapshot=await db.collection('orders').doc(orderId).get({source:'server'});check();
  if(!snapshot.exists)throw Error('保管訂單不存在。');
  const order=snapshot.data(),item=order.items?.[0];
  if(order.items?.length!==1||item?.itemId!==itemId
    ||['sales','engineer'].includes(role)&&order.ownerUid!==uid
    ||order.inventoryReservationStatus!=='completed'||!order.inventoryReservationAttemptId)
   throw Error('此訂單尚未符合保管退貨的原始來源條件。');
  const matching=v3CustodyReturnCandidates(order).find(row=>row.shipmentId===shipmentId
    &&row.lotId===lotId&&qty<=row.maxQty);
  if(!matching)throw Error('退貨數量超過該筆已確認送達的原批次，或已經辦理退貨。');
  const ledger=await db.collection('inventoryReservations').doc(orderId+'__'+itemId).get({source:'server'});check();
  if(!ledger.exists||ledger.data().locationSchemaVersion!==3
    ||ledger.data().custodyTransferId!==item.custodyTransferId)
   throw Error('V3 保管來源與目前預留憑證不一致。');
  frozen={orderId,itemId,shipmentId,operationId,warehouseId:item.warehouseId,
   selections:[{lotId,qty}],date,reason:reason.trim(),condition:'RESTOCKABLE',settlement:'CLOSE',
   syncAttemptId:order.inventoryReservationAttemptId,actorUid:uid,actorRole:role};
  sessionStorage.setItem(key,JSON.stringify(frozen));
 }
 check();functions.useEmulator('127.0.0.1',5001);
 const {actorUid,actorRole,...payload}=frozen;
 const response=await functions.httpsCallable('receiveV3CustodyReturn')(payload);check();
 const result=response?.data;
 if(!['applied','already-applied'].includes(result?.status)||result.orderId!==orderId
   ||result.itemId!==itemId||result.warehouseId!==frozen.warehouseId
   ||result.qty!==qty||result.shipmentId!==shipmentId
   ||result.movementId!=='location-return-'+operationId)
  throw Error('退貨回覆無法確認，請保留原操作編號核對。');
 const refreshed=await db.collection('orders').doc(orderId).get({source:'server'});check();
 const order=refreshed.exists?refreshed.data():null;
 const proof=(order?.returnRecords||[]).find(row=>row.id===operationId);
 if(!proof||proof.itemId!==itemId||proof.shipmentId!==shipmentId
   ||proof.warehouseId!==frozen.warehouseId||proof.qty!==qty
   ||proof.settlement!=='CLOSE'||proof.condition!=='RESTOCKABLE'
   ||proof.date!==date||proof.reason!==reason.trim()
   ||proof.movementId!=='location-return-'+operationId
   ||proof.lotAllocations?.length!==1||proof.lotAllocations[0].lotId!==lotId
   ||proof.lotAllocations[0].qty!==qty)
  throw Error('退貨尚未由權威訂單確認，保留原操作編號。');
 sessionStorage.removeItem(key);
 return order;
}
window.resumeV3CustodyReturn=async function(orderId,itemId){
 const prior=pendingV3CustodyReturn(orderId,itemId);
 if(!prior)throw Error('沒有待恢復的保管退貨。');
 return commitV3CustodyReturn({orderId,itemId,shipmentId:prior.shipmentId,
  lotId:prior.selections[0].lotId,qty:prior.selections[0].qty,date:prior.date,
  reason:prior.reason,operationId:prior.operationId});
};
window.openV3CustodyReturn=async function(orderId){
 const cached=ordersCache.find(row=>row.id===orderId),item=cached?.items?.[0];
 if(cached?.items?.length!==1||!item?.custodyTransferId)return;
 try{
  const prior=pendingV3CustodyReturn(orderId,item.itemId);
  if(prior){
   const saved=await window.resumeV3CustodyReturn(orderId,item.itemId);
   const index=ordersCache.findIndex(row=>row.id===orderId);
   if(index>=0)ordersCache[index]={id:orderId,...saved};
   renderOrdersList();return;
  }
  v3CustodyReturnTransport();
 }catch(error){alert('保管退貨無法繼續：'+error.message);return;}
 const candidates=v3CustodyReturnCandidates(cached);
 if(!candidates.length){alert('此筆訂單沒有可驗證的已送達批次，或曾經辦理退貨。');return;}
 const modal=document.createElement('dialog');modal.className='modal';
 modal.innerHTML=`<form method="dialog" class="modal-content" style="max-width:420px">
  <h3>業務保管退貨實際收回</h3>
  <p>訂單：${escapeHtml(cached.orderNo||orderId)}｜${escapeHtml(item.itemName||item.itemCode||item.itemId)}</p>
  <label>原出貨批次<select name="source" required>${candidates.map((row,index)=>
   `<option value="${index}">${escapeHtml(row.lotNo||row.lotId)}・原出貨 ${escapeHtml(row.shipmentId)}・本次最多 ${row.maxQty}</option>`).join('')}</select></label>
  <label>已實際收回數量<input name="qty" type="number" min="1" max="${candidates[0].maxQty}" value="${candidates[0].maxQty}" step="1" required></label>
  <label>實收日期<input name="date" type="date" value="${escapeAttr(typeof localDateString==='function'?localDateString():new Date().toISOString().slice(0,10))}" required></label>
  <label>退貨原因<textarea name="reason" maxlength="1000" required></textarea></label>
  <p>僅接受已實際收到、可重新入庫之商品；本次 CLOSE 結案，不自動補送。</p>
  <div class="toolbar"><button type="button" data-action="cancel" class="btn-secondary">取消</button>
  <button type="submit">確認實際收回入庫</button></div><p role="status" data-role="status"></p>
 </form>`;
 document.body.appendChild(modal);
 const form=modal.querySelector('form'),save=form.querySelector('button[type="submit"]');
 const source=form.querySelector('select[name="source"]'),quantity=form.querySelector('input[name="qty"]');
 source.addEventListener('change',()=>{
  const candidate=candidates[Number(source.value)];
  if(candidate){quantity.max=String(candidate.maxQty);quantity.value=String(candidate.maxQty);}
 });
 modal.querySelector('[data-action="cancel"]').addEventListener('click',()=>modal.close());
 modal.addEventListener('close',()=>modal.remove(),{once:true});
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(save.disabled)return;
  save.disabled=true;
  const values=new FormData(form),candidate=candidates[Number(values.get('source'))];
  const qty=Number(values.get('qty')),date=String(values.get('date')||'');
  const reason=String(values.get('reason')||'').trim();
  try{
   if(!candidate||!Number.isSafeInteger(qty)||qty<=0||qty>candidate.maxQty)
    throw Error('實收量超過原出貨批次或已送達量。');
   const saved=await commitV3CustodyReturn({orderId,itemId:item.itemId,
    shipmentId:candidate.shipmentId,lotId:candidate.lotId,qty,date,reason,
    operationId:'custody_return_'+crypto.randomUUID().replaceAll('-','_')});
   const index=ordersCache.findIndex(row=>row.id===orderId);
   if(index>=0)ordersCache[index]={id:orderId,...saved};
   modal.close();renderOrdersList();
  }catch(error){form.querySelector('[data-role="status"]').textContent='結果未確認：'+error.message;
   // The first Callable may have committed. Only resume the frozen original ID.
  }finally{save.disabled=false;}
 });
 modal.showModal();
};
