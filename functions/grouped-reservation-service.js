'use strict';

// Limited server-side replacement for expensive grouped (two-warehouse)
// client reservation proofs. Uses the SAME pure Reservation Core as the browser.
// This service never trusts role, stock balances, warehouse or product from a
// caller and makes every business read inside the Firestore transaction.
const {createHash}=require('node:crypto');
const reservationCore=require('./shared/reservation-core.js');
const fulfillmentCore=require('./shared/fulfillment-core.js');
const procurementDemandCore=require('./shared/procurement-demand-core.js');

function fault(code,message){const error=new Error(message);error.code=code;throw error;}
function id(value,label,max=128){
  if(typeof value!=='string'||!value.length||value.length>max||value.includes('/')||value.trim()!==value)
    fault('invalid-argument',label+'不正確');
  return value;
}
function qty(value,label){
  if(!Number.isSafeInteger(value)||value<0||value>1000000)
    fault('invalid-argument',label+'必須是 0–1,000,000 的整數');
  return value;
}
function stockQty(value,label){
  if(!Number.isSafeInteger(value)||value<0)
    fault('failed-precondition',label+'既有數量異常，請先稽核');
  return value;
}
function stockNumbers(data,name){
  const onHand=stockQty(data.onHand,name+'實貨');
  const reserved=stockQty(data.reserved,name+'預留');
  const transferFreeInTransit=stockQty(data.transferFreeInTransit??0,name+'自由調撥途中');
  if(reserved+transferFreeInTransit>onHand)
    fault('failed-precondition',name+'預留／途中帳與實貨不一致');
  return {onHand,reserved,transferFreeInTransit};
}
function productOf(item){
  return String(item.inventoryProductKey||item.productId||'');
}
function fingerprint(orderId,rows){
  return createHash('sha256').update(JSON.stringify({orderId,rows})).digest('hex');
}
function normalizeIntent(data){
  if(!data||typeof data!=='object'||Array.isArray(data))fault('invalid-argument','缺少交易內容');
  // The existing initial-sync intent stays byte-for-byte compatible with
  // receipts already issued by the Preview writer. Amendments are separate
  // operations with a different fingerprint and stricter role/state checks.
  const mode=data.mode===undefined?'initial':data.mode;
  if(!['initial','amend'].includes(mode))fault('invalid-argument','預留交易模式不正確');
  const orderId=id(data.orderId,'訂單 ID');
  const syncAttemptId=id(data.syncAttemptId,'來源同步識別碼',96);
  const attemptId=id(data.attemptId,'操作識別碼',96);
  if(!/^[a-zA-Z0-9_-]{12,96}$/.test(attemptId))fault('invalid-argument','操作識別碼格式不正確');
  if(!Array.isArray(data.items)||data.items.length<2||data.items.length>5)
    fault('invalid-argument','跨倉預留須有 2–5 筆訂單品項');
  const rows=data.items.map(row=>({
    itemId:id(row?.itemId,'訂單品項 ID'),
    quantity:qty(row?.quantity,'預留數量')
  })).sort((a,b)=>a.itemId.localeCompare(b.itemId));
  if(new Set(rows.map(x=>x.itemId)).size!==rows.length)fault('invalid-argument','重複訂單品項 ID');
  // Prevent callers from injecting a proposed stock balance, role, or warehouse.
  if(Object.keys(data).some(k=>!['mode','orderId','attemptId','syncAttemptId','items'].includes(k)))
    fault('invalid-argument','請求含未授權的欄位');
  if(data.items.some(x=>!x||Object.keys(x).some(k=>!['itemId','quantity'].includes(k))))
    fault('invalid-argument','品項請求含未授權的欄位');
  const intentParts=mode==='initial'?[syncAttemptId,...rows]:['amend',syncAttemptId,...rows];
  return {mode,orderId,attemptId,syncAttemptId,rows,hash:fingerprint(orderId,intentParts)};
}
function validateSourceItem(item,order,actorRole,uid){
  const ordered=qty(item.qty??item.orderedQty,'訂購量');
  const delivered=qty(item.deliveredQty??0,'已交付量');
  const returned=qty(item.returnedQty??0,'退貨量');
  if(returned>delivered)fault('failed-precondition','訂單交付或退貨累計異常');
  if(delivered>0||returned>0||Number(item.supplyOrderedQty||0)!==0
    ||Number(item.receivedQty||0)!==0)
    fault('failed-precondition','已履約或有供應進度的品項不可用初始雙倉預留');
  if(item.transferPendingId||item.custodyTransferId||Number(item.dispatchPreparedQty||0)!==0
    ||Number(item.warehouseShippedQty||0)!==0)
    fault('failed-precondition','調撥或出貨途中品項不可重新配置預留');
  if((item.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'
    ||item.productType==='Service'||item.productType==='SERVICE')
    fault('failed-precondition','服務型及原廠直送訂單不得建立實貨預留');
  if(!['admin','purchaser','warehouse'].includes(actorRole)
    && (!['sales','engineer'].includes(actorRole)||order.ownerUid!==uid))
    fault('permission-denied','此帳號不能操作該筆訂單');
  // CLOSE returns do not reopen demand. Gross delivery legitimately may
  // exceed ordered quantity when replacement shipments have occurred.
  const itemId=String(item.itemId||'');
  const linkedReturns=(Array.isArray(order.returnRecords)?order.returnRecords:[])
    .filter(r=>r.itemId===itemId||(!r.itemId&&order.items.length===1));
  const effective=fulfillmentCore.projectOrderDelivery({
    grossDeliveredQty:delivered,returnedQty:returned,returnRecords:linkedReturns
  }).effectiveDelivered;
  if(effective>ordered)fault('failed-precondition','有效交付已超過訂購量');
  return ordered-effective;
}
function projectAfter(stock,delta,label){
  const next=stock.reserved+delta;
  if(!Number.isSafeInteger(next)||next<0||next+stock.transferFreeInTransit>stock.onHand)
    fault('failed-precondition',label+'庫存不足或預留差額異常');
  return next;
}

async function commitGroupedWarehouseReservation(db,uid,data){
  id(uid,'登入 UID');
  const {mode,orderId,attemptId,syncAttemptId,rows,hash}=normalizeIntent(data);
  const ref=(name,key)=>db.collection(name).doc(key);
  const receiptRef=ref('reservationOperationReceipts','grouped-'+attemptId);
  const now=new Date().toISOString();
  return db.runTransaction(async tx=>{
    const userSnap=await tx.get(ref('users',uid));
    if(!userSnap.exists)fault('permission-denied','使用者不存在');
    const user=userSnap.data();
    if(user.active===false||user.disabled===true)fault('permission-denied','使用者帳號已停用');
    const actorRole=user.role;
    if(!['admin','purchaser','warehouse','sales','engineer'].includes(actorRole))
      fault('permission-denied','此帳號沒有預留權限');
    // Post-initial stock amendments are operational decisions, not sales
    // order synchronization. A sales/engineer token can only use the original
    // initial-sync pathway, even when replaying an old receipt.
    if(mode==='amend'&&!['admin','purchaser','warehouse'].includes(actorRole))
      fault('permission-denied','只有採購、倉管或管理員可調整已同步預留');
    const applied=await tx.get(receiptRef);
    if(applied.exists){
      const receipt=applied.data();
      if(receipt.actorUid!==uid||receipt.intentHash!==hash||receipt.orderId!==orderId)
        fault('already-exists','操作識別碼已用於其他交易');
      return {status:'already-applied',receiptId:receiptRef.id,
        productKey:receipt.productKey,companyReservedDelta:receipt.companyReservedDelta};
    }
    const orderRef=ref('orders',orderId),orderSnap=await tx.get(orderRef);
    if(!orderSnap.exists)fault('not-found','來源訂單不存在');
    const order=orderSnap.data();
    const blocked=new Set(['cancelled','canceled','void','voided','deleted','completed','closed','已取消','作廢','已完成','結案']);
    if([order.status,order.orderStatus].some(value=>blocked.has(String(value||'').toLowerCase())))
      fault('failed-precondition','已取消或結案訂單不可重新預留');
    if(!order.ownerUid||!order.salesCode||!Array.isArray(order.items))
      fault('failed-precondition','訂單缺少必要的所有權或品項資料');
    // Initial synchronization and post-sync operational amendments must never
    // authorize each other's state. The persisted source attempt fences both
    // modes against an obsolete client snapshot and receipt replay was handled
    // before this check.
    if(order.inventoryReservationStatus!==(mode==='initial'?'pending':'completed')
      ||order.inventoryReservationAttemptId!==syncAttemptId)
      fault('failed-precondition','來源訂單同步狀態已變更，請重新讀取');
    if(['sales','engineer'].includes(actorRole)&&order.ownerUid!==uid)
      fault('permission-denied','只能操作自己的訂單');
    const lookup=new Map();
    for(let i=0;i<order.items.length;i++){
      const item=order.items[i],key=String(item.itemId||'item-'+(i+1));
      if(lookup.has(key))fault('failed-precondition','來源訂單品項 ID 重複');
      lookup.set(key,{item,index:i});
    }
    const selections=[],warehouses=new Set(),keys=new Set();
    for(const row of rows){
      const source=lookup.get(row.itemId);
      if(!source)fault('failed-precondition','來源訂單品項不存在');
      const {item,index}=source,productKey=id(productOf(item),'產品識別碼',1500);
      const warehouseId=id(item.warehouseId||order.warehouseId,'來源倉庫',200);
      if(warehouseId.startsWith('custody-'))fault('failed-precondition','業務保管位置不可直接預留');
      const demand=validateSourceItem(item,order,actorRole,uid);
      if(row.quantity>demand)fault('failed-precondition','預留超過待交付數量');
      let purchaseDemand=null;
      if(mode==='amend'){
        // Amendments change shortage and therefore the live purchase demand.
        // Read it in the same transaction to fence against supplier commitments
        // that may not yet be reflected in the order-item projection.
        const demandId=procurementDemandCore.demandIdForSource({
          sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:row.itemId});
        const demandRef=ref('procurementDemands',encodeURIComponent(demandId));
        const demandSnap=await tx.get(demandRef);
        const beforeDemand=demandSnap.exists?demandSnap.data():null;
        if(beforeDemand){
          for(const [field,expected] of Object.entries({
            demandId,sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:row.itemId,
            productKey,warehouseId,ownerUid:order.ownerUid,salesCode:order.salesCode
          })){
            if(beforeDemand[field]!==expected)
              fault('failed-precondition','既有採購需求與來源訂單不一致');
          }
          if(beforeDemand.sourceItemIndex!==undefined&&beforeDemand.sourceItemIndex!==-1
            &&beforeDemand.sourceItemIndex!==index)
            fault('failed-precondition','既有採購需求品項位置與訂單不一致');
          if(beforeDemand.status==='CANCELLED'
            ||!Number.isSafeInteger(beforeDemand.orderedQty)||beforeDemand.orderedQty!==0
            ||!Number.isSafeInteger(beforeDemand.receivedQty)||beforeDemand.receivedQty!==0)
            fault('failed-precondition','已有採購承諾或收貨進度，不可調整預留');
        }
        purchaseDemand={ref:demandRef,before:beforeDemand};
      }
      keys.add(productKey);warehouses.add(warehouseId);
      selections.push({row,item,index,productKey,warehouseId,demand,purchaseDemand});
    }
    if(keys.size!==1||warehouses.size!==2)
      fault('failed-precondition','此交易限同一產品、剛好兩個實體倉庫');
    const productKey=[...keys][0];
    const masterIds=[...new Set(selections.map(s=>s.item.productId).filter(Boolean))];
    for(const masterId of masterIds){
      const productSnap=await tx.get(ref('products',id(masterId,'產品主檔 ID',1500)));
      if(!productSnap.exists)fault('failed-precondition','來源品項缺少產品主檔');
      const product=productSnap.data(),type=String(product.productType||product.type||'').toUpperCase();
      if(type==='SERVICE')fault('failed-precondition','服務型訂單不得預留實體庫存');
    }
    const inventoryRef=ref('inventory',encodeURIComponent(productKey));
    const inventorySnap=await tx.get(inventoryRef);
    if(!inventorySnap.exists||inventorySnap.data().productKey!==productKey)
      fault('failed-precondition','找不到符合產品的公司庫存總帳');
    const company=stockNumbers(inventorySnap.data(),'公司');
    const warehouseState=new Map();
    for(const warehouseId of [...warehouses].sort()){
      const master=await tx.get(ref('warehouses',warehouseId));
      const stockRef=ref('warehouseStocks',encodeURIComponent(warehouseId)+'__'+encodeURIComponent(productKey));
      const stockSnap=await tx.get(stockRef);
      if(!master.exists||!stockSnap.exists)
        fault('failed-precondition','來源分倉資料不完整');
      const masterData={...master.data(),id:warehouseId},stockData=stockSnap.data();
      if(masterData.systemCustody||masterData.warehouseType==='CUSTODY'
        ||warehouseId.startsWith('custody-')||stockData.productKey!==productKey
        ||stockData.warehouseId!==warehouseId)
        fault('failed-precondition','來源倉庫不是有效實體庫存位置');
      warehouseState.set(warehouseId,{master:masterData,ref:stockRef,
        before:stockNumbers(stockData,warehouseId),delta:0});
    }
    let companyDelta=0,originalQty=0;
    const changes=[];
    for(const selection of selections){
      const {row,item,index,warehouseId,demand,purchaseDemand}=selection;
      const reservationRef=ref('inventoryReservations',orderId+'__'+row.itemId);
      const existingSnap=await tx.get(reservationRef);
      const before=existingSnap.exists?existingSnap.data():{};
      // Fail closed on unapproved v2 ledgers or historic inconsistent identities.
      for(const [field,expected] of Object.entries({
        orderId,itemId:row.itemId,productKey,warehouseId,ownerUid:order.ownerUid,salesCode:order.salesCode
      })){
        if(before[field]!==undefined&&before[field]!==expected)
          fault('failed-precondition','既有預留來源與訂單不一致');
      }
      const previous=stockQty(before.quantity??0,'原預留');
      if(item.reservedQty!==undefined&&item.reservedQty!==previous)
        fault('failed-precondition','品項預留與庫存預留帳不一致');
      if(before.locationSchemaVersion!==undefined||before.locations!==undefined
        ||before.allocations!==undefined||before.warehouseAllocations!==undefined)
        fault('failed-precondition','此服務尚未開放多位置 ledger');
      if(row.quantity>previous&&warehouseState.get(warehouseId).master.active===false)
        fault('failed-precondition','已停用倉庫不得增加預留');
      const after={...before,orderId,itemId:row.itemId,orderItemIndex:index,ownerUid:order.ownerUid,
        salesCode:order.salesCode,productKey,warehouseId,quantity:row.quantity,
        orderNo:order.orderNo||order.quoteNo||orderId,
        itemCode:item.itemCode||'',itemName:item.itemName||'',customerName:order.customerName||'',
        salesName:order.salesName||'',orderDate:order.orderDate||'',
        shortageQty:demand-row.quantity,status:row.quantity>0?'active':'shortage',
        updatedAt:now};
      const delta=reservationCore.reservationStockDeltas(before,after);
      if(delta.warehouseDeltas.some(v=>v.warehouseId!==warehouseId)
        ||delta.companyReservedDelta!==row.quantity-previous)
        fault('failed-precondition','預留變化不符合共同核心定義');
      companyDelta+=delta.companyReservedDelta;originalQty+=previous;
      const target=warehouseState.get(warehouseId);
      target.delta+=delta.warehouseDeltas.find(x=>x.warehouseId===warehouseId)?.reservedDelta||0;
      changes.push({ref:reservationRef,before,after,index,quantity:row.quantity,
        shortageQty:demand-row.quantity,purchaseDemand,item,warehouseId});
    }
    if(company.reserved<originalQty)fault('failed-precondition','公司預留帳小於來源訂單預留');
    const nextCompany=projectAfter(company,companyDelta,'公司');
    const nextWarehouse=new Map();
    for(const [warehouseId,target] of warehouseState){
      const held=changes.filter(c=>c.after.warehouseId===warehouseId)
        .reduce((sum,c)=>sum+(c.before.quantity||0),0);
      if(target.before.reserved<held)
        fault('failed-precondition','分倉預留帳小於來源訂單預留');
      nextWarehouse.set(warehouseId,projectAfter(target.before,target.delta,warehouseId));
    }
    const nextItems=order.items.map(item=>({...item}));
    for(const change of changes){
      nextItems[change.index].reservedQty=change.quantity;
      nextItems[change.index].shortageQty=change.shortageQty;
      nextItems[change.index].inventoryProductKey=productKey;
    }
    // Every read above precedes all writes; transaction retries re-read all
    // authoritative sources. A committed receipt makes response retries safe.
    if(companyDelta!==0)tx.update(inventoryRef,{reserved:nextCompany,updatedAt:now});
    for(const [warehouseId,target] of warehouseState){
      if(target.delta!==0){
        tx.update(target.ref,{reserved:nextWarehouse.get(warehouseId),updatedAt:now});
        const movementRef=ref('inventoryMovements','grouped-'+attemptId+'-'+encodeURIComponent(warehouseId));
        tx.create(movementRef,{sourceType:'order',sourceId:orderId,productKey,warehouseId,
          type:target.delta>0?'reserve':'release',qty:target.delta,
          actorUid:uid,actorRole,createdAt:now,reservationOperationId:receiptRef.id});
      }
    }
    for(const change of changes)if(change.before.quantity!==change.quantity)
      tx.set(change.ref,change.after,{merge:true});
    if(mode==='amend')for(const change of changes){
      if(change.before.quantity===change.quantity)continue;
      const {purchaseDemand,item,index,shortageQty,warehouseId}=change;
      const previous=purchaseDemand.before;
      const projection=procurementDemandCore.fromSalesOrder({
        sourceId:orderId,sourceItemId:change.after.itemId,sourceItemIndex:index,
        fulfillmentType:'WAREHOUSE',shortageQty,supplyOrderedQty:0,receivedQty:0,
        productId:item.productId||'',productKey,itemCode:item.itemCode||'',
        itemName:item.itemName||'',brand:item.brand||'',warehouseId,
        ownerUid:order.ownerUid,salesCode:order.salesCode,salesName:order.salesName||'',
        scheduleDate:previous?.scheduleDate||item.requiredByDate||item.scheduleDate
          ||order.requiredByDate||order.expectedDate||''
      });
      const demandDoc=procurementDemandCore.demandDocument(projection,{
        createdAt:previous?.createdAt||order.createdAt||now,updatedAt:now});
      if(previous){
        tx.update(purchaseDemand.ref,{
          requestedQty:demandDoc.requestedQty,remainingToOrderQty:demandDoc.remainingToOrderQty,
          remainingToReceiveQty:demandDoc.remainingToReceiveQty,perOrdered:demandDoc.perOrdered,
          perReceived:demandDoc.perReceived,status:demandDoc.status,
          sourceItemIndex:index,updatedAt:now
        });
      }else if(demandDoc.requestedQty>0)tx.create(purchaseDemand.ref,demandDoc);
    }
    if(changes.some(c=>c.before.quantity!==c.quantity))
      tx.update(orderRef,{items:nextItems,updatedAt:now});
    tx.create(receiptRef,{action:mode==='initial'?'grouped_reservation':'grouped_reservation_amend',orderId,productKey,
      actorUid:uid,actorRole,syncAttemptId,intentHash:hash,companyReservedDelta:companyDelta,
      warehouseIds:[...warehouses].sort(),reservationIds:changes.map(c=>c.ref.id),
      createdAt:now,status:'applied'});
    return {status:'applied',receiptId:receiptRef.id,productKey,companyReservedDelta:companyDelta};
  });
}
module.exports={commitGroupedWarehouseReservation,normalizeIntent};
