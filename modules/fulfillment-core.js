(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.YushinFulfillment = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function n(value) {
    const num = Number(value);
    return Number.isFinite(num) ? Math.max(0, num) : 0;
  }

  function clamp(value, min, max) {
    return Math.min(Math.max(n(value), n(min)), n(max));
  }

  // deliveredQty is always cumulative here. Callers exclude CLOSE returns
  // before projecting replacement demand; physical return history stays intact.
  function deliveryQuantities(item = {}) {
    const grossDeliveredQty = n(item.deliveredQty);
    const returnedQty = Math.min(n(item.returnedQty), grossDeliveredQty);
    return { grossDeliveredQty, returnedQty,
      effectiveDeliveredQty: Math.max(0, grossDeliveredQty - returnedQty) };
  }

  // Canonical order-level delivery and return projection. CLOSE means no replacement.
  function projectOrderDelivery({grossDeliveredQty = 0, returnedQty = 0, returnRecords = []} = {}) {
    const grossDelivered = n(grossDeliveredQty);
    const returned = Math.min(grossDelivered, n(returnedQty));
    const closedReturns = Math.min(returned,
      (Array.isArray(returnRecords) ? returnRecords : [])
        .filter(row => row?.settlement === 'CLOSE')
        .reduce((sum, row) => sum + n(row?.qty), 0));
    const effectiveDelivered = deliveryQuantities({
      deliveredQty: grossDelivered,
      returnedQty: returned - closedReturns
    }).effectiveDeliveredQty;
    return {grossDelivered, returned, closedReturns, effectiveDelivered};
  }

  function normalizeItem(item = {}, index = 0) {
    const orderedQty = n(item.orderedQty ?? item.qty);
    // 採購、到貨、打單、送貨與退貨都是累計事件量。
    // 發生退貨後補送時，累計量可以合理超過原始 orderedQty，不能截回原訂購量。
    const supplyOrderedQty = n(item.supplyOrderedQty);
    const receivedQty = n(item.receivedQty);
    const dispatchPreparedQty = n(item.dispatchPreparedQty);
    const delivery = deliveryQuantities(item);
    const deliveredQty = delivery.grossDeliveredQty;
    const returnedQty = delivery.returnedQty;
    const fulfilledQty = clamp(delivery.effectiveDeliveredQty, 0, orderedQty);
    const outstandingQty = Math.max(0, orderedQty - fulfilledQty);
    const reservedQty = clamp(item.reservedQty, 0, outstandingQty);
    // Service work remaining is not a physical stock shortage. Keep recorded
    // stock/supplier quantities visible so their validators can reject conflicts.
    const shortageQty = String(item.productType||'').trim().toUpperCase()==='SERVICE'
      ? 0 : Math.max(0, outstandingQty - reservedQty);
    return {
      ...item,
      itemId: String(item.itemId || `item-${index + 1}`),
      qty: orderedQty,
      orderedQty,
      reservedQty,
      shortageQty,
      supplyOrderedQty,
      receivedQty,
      dispatchPreparedQty,
      deliveredQty,
      returnedQty
    };
  }

  function dispatchState(item = {}) {
    // Dispatch 只需要物流事件量與「目前仍被預留」的庫存。
    // 不先 normalizeItem()，避免在缺少 orderedQty 的輕量快照中把 live reservedQty 截成 0。
    // reservedQty 的合法性由 reservation / inventory transaction 維護；這裡只負責算待打單與可出貨。
    const delivery = deliveryQuantities(item);
    const grossDelivered = delivery.grossDeliveredQty;
    const returned = delivery.returnedQty;
    const delivered = delivery.effectiveDeliveredQty;
    const reserved = n(item.reservedQty);
    const prepared = n(item.dispatchPreparedQty);
    const preparedOutstanding = Math.max(0, prepared - grossDelivered);
    const shippable = Math.max(0, Math.min(reserved, preparedOutstanding));
    const pending = Math.max(0, reserved - shippable);
    return { delivered, grossDelivered, returned, reserved, prepared, preparedOutstanding, shippable, pending };
  }

  // Physical warehouse shipment is a separate event from customer delivery.
  // Reuse the same cumulative preparation budget, with shipped quantity as
  // the consumed budget; never change delivery records through this adapter.
  function warehouseShipmentState(item = {}) {
    const shippedQty = n(item.warehouseShippedQty);
    const state = dispatchState({ deliveredQty: shippedQty,
      reservedQty: item.reservedQty, dispatchPreparedQty: item.dispatchPreparedQty });
    return { shippedQty, reserved: state.reserved, prepared: state.prepared,
      preparedOutstanding: state.preparedOutstanding, shippable: state.shippable, pending: state.pending };
  }

  // Canonical v2 shipment/acknowledgement projection. Legacy deliveries and
  // returns must not be mixed into this explicitly bounded migration contract.
  function projectShipmentDelivery({orderId,itemId,productKey,orderedQty,shipments=[],deliveries=[]} = {}) {
    const ident=value=>{
      if(typeof value!=='string'||!value||value!==value.trim()||value.includes('/')||value.length>160)
        throw Error('出貨或送達識別資料不正確。');
      return value;
    };
    const qty=value=>{
      if(!Number.isSafeInteger(value)||value<0)throw Error('出貨或送達數量必須為非負整數。');
      return value;
    };
    const date=value=>{
      if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)
        ||!Number.isFinite(Date.parse(value+'T00:00:00Z'))
        ||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)
        throw Error('出貨或送達日期不正確。');
      return value;
    };
    [orderId,itemId,productKey].forEach(ident);qty(orderedQty);
    if(!Array.isArray(shipments)||!Array.isArray(deliveries)||shipments.length>200||deliveries.length>200)
      throw Error('出貨或送達紀錄格式不正確或超過安全上限。');
    const source=new Map();let shippedQty=0,confirmedQty=0;
    for(const row of shipments){
      ident(row?.id);ident(row.warehouseId);date(row.date);
      if(source.has(row.id)||row.orderId!==orderId||row.itemId!==itemId||row.productKey!==productKey
        ||row.sourceType!=='WAREHOUSE_CUSTOMER_SHIPMENT'||qty(row.qty)===0)
        throw Error('倉庫出貨紀錄來源不一致或重複。');
      shippedQty=qty(shippedQty+row.qty);
      if(shippedQty>orderedQty)throw Error('倉庫出貨總量超過訂購量。');
      source.set(row.id,{shipment:row,confirmedQty:0});
    }
    const seen=new Set();
    for(const row of deliveries){
      ident(row?.id);ident(row.shipmentId);date(row.date);
      const target=source.get(row.shipmentId);
      if(seen.has(row.id)||!target||row.orderId!==orderId||row.itemId!==itemId||row.productKey!==productKey
        ||row.warehouseId!==target.shipment.warehouseId||row.sourceType!=='WAREHOUSE_SHIPMENT_CONFIRMATION'
        ||qty(row.qty)===0||row.date<target.shipment.date)
        throw Error('客戶送達未對應有效出貨紀錄或日期不一致。');
      seen.add(row.id);target.confirmedQty=qty(target.confirmedQty+row.qty);
      if(target.confirmedQty>target.shipment.qty)throw Error('送達量超過該筆倉庫出貨量。');
      confirmedQty=qty(confirmedQty+row.qty);
    }
    const delivery=projectOrderDelivery({grossDeliveredQty:confirmedQty});
    return {shippedQty,unshippedQty:orderedQty-shippedQty,confirmedQty:delivery.effectiveDelivered,pendingDeliveryQty:shippedQty-delivery.effectiveDelivered,
      isDelivered:orderedQty>0&&delivery.effectiveDelivered===orderedQty,
      shipments:[...source].map(([shipmentId,row])=>({shipmentId,shippedQty:row.shipment.qty,
        confirmedQty:row.confirmedQty,pendingQty:row.shipment.qty-row.confirmedQty}))};
  }

  // Match an immutable physical debit to its source shipment. The backend
  // acknowledgement adapter additionally verifies its normalized intent hash.
  function validateShipmentMovement(shipment,movement,{orderId,itemId,productKey}={}) {
    const allocations=shipment?.lotAllocations;
    if(!shipment||shipment.orderId!==orderId||shipment.itemId!==itemId||shipment.productKey!==productKey
      ||shipment.sourceType!=='WAREHOUSE_CUSTOMER_SHIPMENT'
      ||shipment.movementId!=='location-ship-'+shipment.id
      ||!Number.isSafeInteger(shipment.qty)||shipment.qty<=0
      ||!Array.isArray(allocations)||!allocations.length||allocations.length>200
      ||allocations.some(a=>!a||typeof a.lotId!=='string'||!a.lotId||!Number.isSafeInteger(a.qty)||a.qty<=0)
      ||new Set(allocations.map(a=>a.lotId)).size!==allocations.length
      ||allocations.reduce((sum,a)=>sum+a.qty,0)!==shipment.qty
      ||!movement||movement.action!=='location_customer_shipment'||movement.type!=='ship'
      ||movement.sourceId!==orderId||movement.itemId!==itemId||movement.productKey!==productKey
      ||movement.warehouseId!==shipment.warehouseId||movement.qty!==-shipment.qty
      ||!sameRecord(movement.lotAllocations,allocations))
      throw Error('來源倉庫出貨與實際扣帳憑證不一致。');
    return true;
  }

  // Immutable events contain plain Firestore data; key order is immaterial.
  function sameRecord(a,b){
    if(a===b)return true;
    if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;
    const keys=Object.keys(a);
    return keys.length===Object.keys(b).length&&keys.every(k=>Object.prototype.hasOwnProperty.call(b,k)&&sameRecord(a[k],b[k]));
  }

  function returnFault(message,code='failed-precondition'){const e=new Error(message);e.code=code;throw e;}
  function returnId(value){
   if(typeof value!=='string'||!value||value!==value.trim()||value.includes('/')||value.length>160)
    returnFault('退貨追溯識別碼不正確','invalid-argument');
   return value;
  }
  function normalizeReturnTraceIntent(data){
   if(!data||typeof data!=='object'||Array.isArray(data)
    ||Object.keys(data).some(k=>!['orderId','itemId','shipmentId','syncAttemptId','selections'].includes(k)))
    returnFault('退貨追溯請求含未授權欄位','invalid-argument');
   const intent={};for(const key of ['orderId','itemId','shipmentId','syncAttemptId'])intent[key]=returnId(data[key]);
   if(intent.syncAttemptId.length>96||!Array.isArray(data.selections)||!data.selections.length||data.selections.length>200)
    returnFault('退貨批次選擇不正確','invalid-argument');
   intent.selections=data.selections.map(row=>{
    if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(k=>!['lotId','qty'].includes(k))
     ||!Number.isSafeInteger(row.qty)||row.qty<=0)returnFault('退貨批次數量不正確','invalid-argument');
    return {lotId:returnId(row.lotId),qty:row.qty};
   });
   if(new Set(intent.selections.map(row=>row.lotId)).size!==intent.selections.length)
    returnFault('退貨批次重複','invalid-argument');
   return intent;
  }
  function normalizeLocationReturnIntent(data){
   const keys=['orderId','itemId','shipmentId','syncAttemptId','selections','operationId','warehouseId','date','reason','condition','settlement','requestId'];
   if(!data||typeof data!=='object'||Array.isArray(data)||Object.keys(data).some(k=>!keys.includes(k)))
    returnFault('退貨入庫請求含未授權欄位','invalid-argument');
   const intent=normalizeReturnTraceIntent(Object.fromEntries(['orderId','itemId','shipmentId','syncAttemptId','selections'].map(k=>[k,data[k]])));
   const settlement=data.settlement===undefined?'CLOSE':data.settlement;
   if(typeof data.operationId!=='string'||!/^[a-zA-Z0-9_-]{12,96}$/.test(data.operationId)
    ||typeof data.warehouseId!=='string'||!data.warehouseId||data.warehouseId!==data.warehouseId.trim()
    ||data.warehouseId.includes('/')||data.warehouseId.length>160)
    returnFault('退貨入庫操作或收貨倉識別碼不正確','invalid-argument');
   if(typeof data.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(data.date)
    ||!Number.isFinite(Date.parse(data.date+'T00:00:00Z'))
    ||new Date(data.date+'T00:00:00Z').toISOString().slice(0,10)!==data.date)
    returnFault('退貨入庫日期不正確','invalid-argument');
   if(typeof data.reason!=='string'||!data.reason.trim()||data.reason.length>1000
    ||data.condition!=='RESTOCKABLE'||!['CLOSE','REPLACE'].includes(settlement))
    returnFault('退貨原因、品質或補送／結案決策不正確','invalid-argument');
   // Lot order has no business meaning. Stable ordering makes retries deterministic.
   intent.selections.sort((a,b)=>a.lotId.localeCompare(b.lotId));
   Object.assign(intent,{operationId:data.operationId,warehouseId:data.warehouseId,date:data.date,
    reason:data.reason.trim(),condition:data.condition,settlement});
   // Omit this field for historical callers: their canonical hash stays unchanged.
   if(Object.prototype.hasOwnProperty.call(data,'requestId')){
    intent.requestId=returnId(data.requestId);
    if(settlement!=='CLOSE')returnFault('申請實收僅支援 CLOSE 結案','invalid-argument');
   }
   return intent;
  }

  // Database reads and SHA-256 implementations remain platform adapters.
  // This validator is shared by the original receiving and return Services.
  async function validateLocationReturnProofs(order,intent,productKey,receipts,{closedOnly=false,hashIntent}={}){
   const {orderId,itemId}=intent;
   if(!Array.isArray(order.returnRecords))returnFault('退貨紀錄格式不正確');
   if(closedOnly&&order.returnRecords.some(r=>r?.settlement!=='CLOSE'))
    returnFault('退貨或補送流程尚未開放：此入口僅支援 CLOSE 結案退貨');
   if(receipts.length>200||receipts.length!==order.returnRecords.length)returnFault('退貨紀錄與實際入庫憑證數量不一致');
   const byMovement=new Map(receipts.map(s=>[s.id,s.data]));
   for(const row of order.returnRecords){
    if(!Array.isArray(row.lotAllocations))returnFault('先前退貨缺少批次明細');
    const priorIntent=normalizeLocationReturnIntent({orderId,itemId,shipmentId:row.shipmentId,
     syncAttemptId:intent.syncAttemptId,selections:row.lotAllocations.map(a=>({lotId:a.lotId,qty:a.qty})),
     operationId:row.id,warehouseId:row.warehouseId,date:row.date,reason:row.reason,
     condition:row.condition,settlement:row.settlement,
     ...(Object.prototype.hasOwnProperty.call(row,'requestId')?{requestId:row.requestId}:{})});
    const hash=await hashIntent(priorIntent);
    const proof=byMovement.get('location-return-'+row.id);
    if(row.movementId!=='location-return-'+row.id||row.intentHash!==hash||!proof
     ||proof.action!=='location_customer_return'||proof.type!=='return'
     ||proof.qty!==row.qty||proof.sourceId!==orderId||proof.itemId!==itemId
     ||proof.productKey!==productKey||proof.warehouseId!==row.warehouseId
     ||proof.intentHash!==hash||!sameRecord(proof.returnRecord,row))
     returnFault('先前退貨缺少一致的實際入庫憑證');
   }
   return true;
  }
  // Validate the entire event/proof set before partitioning by source item.
  // Both browser receiving and backend lifecycle/returns use this adapter.
  async function validateOrderLocationReturnProofs(order,intent,productKey,receipts,options={}){
   const records=order.returnRecords??[];
   if(!Array.isArray(order.items)||order.items.length<=1)
    return validateLocationReturnProofs({...order,returnRecords:records},intent,productKey,receipts,options);
   const projection=projectOrderShipmentReturns({orderId:intent.orderId,items:order.items,
    shipments:order.warehouseShipmentRecords??[],deliveries:order.deliveryRecords??[],returns:records});
   if(receipts.length>200||receipts.length!==records.length
    ||receipts.some(row=>!projection.items.some(item=>item.itemId===row.data?.itemId)))
    returnFault('整單退貨紀錄與實際入庫憑證數量或來源不一致');
   for(const item of projection.items)await validateLocationReturnProofs(
    {...order,returnRecords:records.filter(row=>row.itemId===item.itemId)},
    {...intent,itemId:item.itemId},item.productKey,receipts.filter(row=>row.data.itemId===item.itemId),options);
   return true;
  }
  // Physical returns do not erase historical shipments/acknowledgements.
  // CLOSE fulfils that quantity commercially; REPLACE reopens demand.
  function projectShipmentReturns(input={}) {
    const base=projectShipmentDelivery(input),records=input.returns??[];
    if(!Array.isArray(records)||records.length>200)throw Error('退貨紀錄格式不正確或超過安全上限。');
    const seen=new Set(),totals=new Map();let returnedQty=0,closedQty=0;
    // A later acknowledgement of the remaining shipment does not invalidate
    // an earlier return. Validate each return against delivery actually
    // confirmed by that date, in chronological order (input order is a cache).
    for(const row of [...records].sort((a,b)=>String(a?.date||'').localeCompare(String(b?.date||'')))){
      const source=(input.shipments||[]).find(s=>s.id===row?.shipmentId);
      const delivered=base.shipments.find(s=>s.shipmentId===row?.shipmentId);
      if(typeof row?.id!=='string'||!row.id||seen.has(row.id)||!source||!delivered
        ||row.orderId!==input.orderId||row.itemId!==input.itemId||row.productKey!==input.productKey
        ||row.warehouseId!==source.warehouseId||row.sourceType!=='WAREHOUSE_CUSTOMER_RETURN'
        ||!['CLOSE','REPLACE'].includes(row.settlement)||row.condition!=='RESTOCKABLE'
        ||!Number.isSafeInteger(row.qty)||row.qty<=0
        ||typeof row.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(row.date)
        ||!Number.isFinite(Date.parse(row.date+'T00:00:00Z'))
        ||new Date(row.date+'T00:00:00Z').toISOString().slice(0,10)!==row.date
        ||row.date<source.date)
        throw Error('退貨未對應有效出貨／送達來源或結案方式不正確。');
      seen.add(row.id);const total=(totals.get(row.shipmentId)||0)+row.qty;
      const confirmedByDate=(input.deliveries||[]).filter(d=>d.shipmentId===row.shipmentId&&d.date<=row.date)
        .reduce((sum,d)=>sum+d.qty,0);
      if(!Number.isSafeInteger(total)||total>confirmedByDate)throw Error('退貨超過該筆當時已送達量。');
      totals.set(row.shipmentId,total);returnedQty+=row.qty;
      if(row.settlement==='CLOSE')closedQty+=row.qty;
    }
    const replacementQty=returnedQty-closedQty;
    const effectiveDeliveredQty=projectOrderDelivery({grossDeliveredQty:base.confirmedQty,returnedQty,
      returnRecords:records}).effectiveDelivered;
    return {...base,returnedQty,closedQty,replacementQty,effectiveDeliveredQty,
      outstandingQty:input.orderedQty-base.shippedQty+replacementQty,
      isDelivered:input.orderedQty>0&&effectiveDeliveredQty===input.orderedQty};
  }

  // Bounded order adapter around the original per-item authority. Partition
  // only after validating the whole event set, so unknown/duplicate events
  // cannot disappear through a page's item filter.
  function projectOrderShipmentReturns({orderId,items,shipments=[],deliveries=[],returns=[]}={}) {
    const ident=value=>{
      if(typeof value!=='string'||!value||value!==value.trim()||value.includes('/')||value.length>160)
        throw Error('整單履約識別資料不正確。');
      return value;
    };
    ident(orderId);
    if(!Array.isArray(items)||!items.length||items.length>5)throw Error('整單履約僅支援 1–5 個品項。');
    const sources=new Map(),allIds=new Set();
    for(const item of items){
      const itemId=ident(item?.itemId);
      if(allIds.has(itemId))throw Error('整單履約品項識別碼重複。');
      allIds.add(itemId);
      if(String(item.productType||item.type||'').trim().toUpperCase()==='SERVICE'){
        // Service quantity is commercial work, never physical supply or delivery.
        for(const field of ['reservedQty','shortageQty','supplyOrderedQty','receivedQty',
          'dispatchPreparedQty','warehouseShippedQty','deliveredQty','returnedQty'])
          if(item[field]!==undefined&&item[field]!==0)
            throw Error('服務品項不可含實貨、供應或送達數量。');
        continue;
      }
      const productKey=ident(item.inventoryProductKey||item.productId);
      const orderedQty=item.qty??item.orderedQty;
      if(sources.has(itemId)||!Number.isSafeInteger(orderedQty)||orderedQty<=0
        ||(item.qty!==undefined&&item.orderedQty!==undefined&&item.qty!==item.orderedQty))
        throw Error('整單履約品項重複或訂購量不正確。');
      sources.set(itemId,{itemId,productKey,orderedQty});
    }
    if(!sources.size)throw Error('整單實貨履約缺少商品品項。');
    for(const records of [shipments,deliveries,returns]){
      if(!Array.isArray(records)||records.length>200)throw Error('整單履約事件格式不正確或超過安全上限。');
      const seen=new Set();
      for(const row of records){
        const eventId=ident(row?.id),source=sources.get(row.itemId);
        if(seen.has(eventId)||!source||row.orderId!==orderId||row.productKey!==source.productKey)
          throw Error('整單履約事件來源不一致或重複。');
        seen.add(eventId);
      }
    }
    const projected=[...sources.values()].map(source=>({...source,...projectShipmentReturns({orderId,...source,
      shipments:shipments.filter(row=>row.itemId===source.itemId),
      deliveries:deliveries.filter(row=>row.itemId===source.itemId),returns:returns.filter(row=>row.itemId===source.itemId)})}));
    const result={orderId,items:projected,isDelivered:projected.every(item=>item.isDelivered)};
    for(const field of ['orderedQty','shippedQty','unshippedQty','confirmedQty','pendingDeliveryQty',
      'returnedQty','closedQty','replacementQty','effectiveDeliveredQty','outstandingQty']){
      result[field]=projected.reduce((sum,item)=>sum+item[field],0);
      if(!Number.isSafeInteger(result[field])||result[field]<0)throw Error('整單履約合計超過安全數量。');
    }
    return result;
  }

  function pendingDispatchQty(item) {
    return dispatchState(item).pending;
  }

  function shippableQty(item) {
    return dispatchState(item).shippable;
  }

  function prepareDispatch(item, qty) {
    const x = normalizeItem(item);
    const applied = Math.min(n(qty), pendingDispatchQty(x));
    return normalizeItem({ ...x, dispatchPreparedQty: x.dispatchPreparedQty + applied });
  }

  function deliver(item, qty) {
    const x = normalizeItem(item);
    const applied = Math.min(n(qty), shippableQty(x));
    return normalizeItem({
      ...x,
      deliveredQty: x.deliveredQty + applied,
      reservedQty: Math.max(0, x.reservedQty - applied)
    });
  }

  function returnDelivery(item, qty) {
    const x = normalizeItem(item);
    const applied = Math.min(n(qty), Math.max(0, x.deliveredQty - x.returnedQty));
    return normalizeItem({ ...x, returnedQty: x.returnedQty + applied });
  }

  return {
    deliveryQuantities,
    projectOrderDelivery,
    normalizeItem,
    dispatchState,
    warehouseShipmentState,
    projectShipmentDelivery,
    validateShipmentMovement,
    normalizeReturnTraceIntent,
    normalizeLocationReturnIntent,
    validateLocationReturnProofs,
    validateOrderLocationReturnProofs,
    projectShipmentReturns,
    projectOrderShipmentReturns,
    pendingDispatchQty,
    shippableQty,
    prepareDispatch,
    deliver,
    returnDelivery
  };
});

