'use strict';

// A single, retry-safe initial reservation writer for an entire new order.
// Unlike the former browser per-item transactions, every stock, reservation,
// purchase-demand and order-item projection commits together or not at all.
const demandCore=require('./shared/procurement-demand-core.js');
const fulfillmentCore=require('./shared/fulfillment-core.js');
const workflowCore=require('./shared/workflow-core.js');
const reservationCore=require('./shared/reservation-core.js');

function fault(code,message){const error=new Error(message);error.code=code;throw error;}
function ident(value,label,max=160){
  if(typeof value!=='string'||!value||value.length>max||value.trim()!==value||value.includes('/'))
    fault('invalid-argument',label+'不正確');
  return value;
}
function quantity(value,label){
  if(!Number.isSafeInteger(value)||value<0||value>1000000)
    fault('failed-precondition',label+'必須是有效的非負整數');
  return value;
}
function stockNumbers(value,label){
  const onHand=quantity(value?.onHand??0,label+'實貨');
  const reserved=quantity(value?.reserved??0,label+'預留');
  const transferFreeInTransit=quantity(value?.transferFreeInTransit??0,label+'在途');
  if(reserved+transferFreeInTransit>onHand)fault('failed-precondition',label+'庫存帳目不一致');
  return {onHand,reserved,transferFreeInTransit,available:onHand-reserved-transferFreeInTransit,delta:0};
}
function normalizeOrderReservationIntent(data){
  if(!data||typeof data!=='object'||Array.isArray(data)
    ||Object.keys(data).some(key=>!['orderId','syncAttemptId'].includes(key)))
    fault('invalid-argument','只允許傳入訂單與來源同步識別碼');
  const orderId=ident(data.orderId,'訂單 ID');
  const syncAttemptId=ident(data.syncAttemptId,'同步識別碼',96);
  if(!/^[a-zA-Z0-9_-]{12,96}$/.test(syncAttemptId))fault('invalid-argument','同步識別碼格式不正確');
  return {orderId,syncAttemptId};
}
function productKeyOf(item,productId){
  const code=String(item.itemCode||'').trim().toUpperCase().replace(/\s+/g,'');
  const key=productId||(code?'code:'+code:'');
  if(item.inventoryProductKey&&item.inventoryProductKey!==key)
    fault('failed-precondition','來源品項產品識別與主檔／貨號不一致');
  return key;
}

function initialOrderWorkIndex(order,items,now){
  // Reuse the same item/dispatch core as the order screen. The status change
  // must not strand a newly reserved line outside its work queue.
  const hasService=items.some(item=>String(item.productType||'').toUpperCase()==='SERVICE');
  if(hasService&&Array.isArray(order.workCategories)
    &&(order.workCategoryUpdatedAt||order.workCategories.some(c=>c==='billing'||c==='complete')))
    return {};
  const categories=[...new Set(items.flatMap((source,index)=>{
    const item=fulfillmentCore.normalizeItem(source,index);
    const dispatch=fulfillmentCore.dispatchState(item);
    const category=workflowCore.itemWorkCategory({lifecycleStatus:'normal',
      returnedQty:dispatch.returned,effectiveDeliveredQty:dispatch.delivered,
      orderedQty:item.orderedQty,deliveredQty:dispatch.grossDelivered,
      isBilled:!!order.isBilled,fulfillmentType:item.fulfillmentType||order.fulfillmentType||'WAREHOUSE',
      productType:item.productType||order.productType||'',reservedQty:item.reservedQty,
      shortageQty:item.shortageQty,supplyOrderedQty:item.supplyOrderedQty,receivedQty:item.receivedQty});
    const warehouse=(item.fulfillmentType||order.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP'
      &&String(item.productType||'').toUpperCase()!=='SERVICE';
    return warehouse&&['ordering','arrival','delivery'].includes(category)&&dispatch.pending>0
      ? [category,'dispatch'] : [category];
  }))];
  return {workCategories:categories.length?categories:['ordering'],workCategoryUpdatedAt:now};
}

async function commitOrderReservation(db,uid,data){
  ident(uid,'登入 UID');
  const {orderId,syncAttemptId}=normalizeOrderReservationIntent(data);
  const ref=(name,key)=>db.collection(name).doc(key);
  const receiptRef=ref('reservationOperationReceipts','order-sync-'+orderId+'__'+syncAttemptId);
  return db.runTransaction(async tx=>{
    const userSnap=await tx.get(ref('users',uid));
    if(!userSnap.exists||userSnap.data().active===false||userSnap.data().disabled===true)
      fault('permission-denied','使用者不存在或已停用');
    const user=userSnap.data(),role=user.role;
    if(!['admin','purchaser','warehouse','sales','engineer'].includes(role))
      fault('permission-denied','沒有訂單庫存同步權限');
    const receiptSnap=await tx.get(receiptRef);
    if(receiptSnap.exists){
      const receipt=receiptSnap.data();
      if(receipt.orderId!==orderId||receipt.syncAttemptId!==syncAttemptId||receipt.actorUid!==uid)
        fault('already-exists','同步憑證與呼叫者不一致');
      return {status:'already-applied',receiptId:receiptRef.id,
        reservedQty:receipt.reservedQty,shortageQty:receipt.shortageQty};
    }
    const orderRef=ref('orders',orderId),orderSnap=await tx.get(orderRef);
    if(!orderSnap.exists)fault('not-found','來源訂單不存在');
    const order=orderSnap.data();
    if(!order.ownerUid||!order.salesCode||!Array.isArray(order.items)
      ||order.items.length<1||order.items.length>50)
      fault('failed-precondition','訂單所有權、業務代碼或品項資料不完整');
    if(['cancelled','canceled','void','voided','deleted','completed','closed','已取消','作廢','已完成','結案']
      .some(value=>[order.status,order.orderStatus].some(status=>String(status||'').toLowerCase()===value)))
      fault('failed-precondition','已取消或結案訂單不可同步預留');
    if(order.inventoryReservationStatus!=='pending'||order.inventoryReservationAttemptId!==syncAttemptId)
      fault('failed-precondition','已有較新的庫存同步工作');
    if(['sales','engineer'].includes(role)&&order.ownerUid!==uid)
      fault('permission-denied','只能同步自己的訂單');

    const now=new Date().toISOString();
    const productMasters=new Map(),warehouseMasters=new Map();
    const companyStocks=new Map(),warehouseStocks=new Map(),warehouseCandidates=new Map();
    const writes=[],nextItems=[],seenItems=new Set();
    let reservedQty=0,shortageQty=0;
    async function master(collection,key,cache){
      if(!cache.has(key)){
        const snap=await tx.get(ref(collection,key));
        cache.set(key,snap.exists?snap.data():null);
      }
      return cache.get(key);
    }
    async function trackedStock(collection,key,cache,label,identity={}){
      if(!cache.has(key)){
        const docRef=ref(collection,key),snap=await tx.get(docRef);
        cache.set(key,{ref:docRef,exists:snap.exists,...identity,
          ...stockNumbers(snap.exists?snap.data():{},label)});
        if(snap.exists){
          const data=snap.data();
          if(collection==='inventory'&&data.productKey!==decodeURIComponent(key))
            fault('failed-precondition','公司庫存產品識別不一致');
          if(collection==='warehouseStocks'&&
            (data.productKey!==identity.productKey||data.warehouseId!==identity.warehouseId))
            fault('failed-precondition','分倉庫存識別不一致');
        }
      }
      return cache.get(key);
    }
    async function chooseSingleWarehouse(productKey,preferredId,requested,aggregateAvailable){
      // A single item's legacy ledger can point to only ONE physical location.
      // Read every stocked candidate inside this transaction; source warehouse
      // IDs and client-side stock estimates cannot authorize an allocation.
      if(!warehouseCandidates.has(productKey)){
        const query=db.collection('warehouseStocks').where('productKey','==',productKey);
        const matches=await tx.get(query),candidates=new Map();
        for(const snapshot of matches.docs){
          const record=snapshot.data(),id=ident(record.warehouseId,'分倉庫存位置',200);
          const key=encodeURIComponent(id)+'__'+encodeURIComponent(productKey);
          if(snapshot.id!==key||record.productKey!==productKey||candidates.has(id))
            fault('failed-precondition','分倉庫存識別不一致，請先稽核');
          let stock=warehouseStocks.get(key);
          if(!stock){
            stock={ref:ref('warehouseStocks',key),exists:true,warehouseId:id,productKey,
              ...stockNumbers(record,id)};
            warehouseStocks.set(key,stock);
          }
          candidates.set(id,stock);
        }
        warehouseCandidates.set(productKey,candidates);
      }
      const candidates=warehouseCandidates.get(productKey);
      if(!candidates.has(preferredId)){
        const key=encodeURIComponent(preferredId)+'__'+encodeURIComponent(productKey);
        candidates.set(preferredId,await trackedStock('warehouseStocks',key,warehouseStocks,preferredId,
          {warehouseId:preferredId,productKey}));
      }
      const physical=[],stocks={};
      let totalAvailable=0;
      for(const [id,stock] of candidates){
        const warehouse=await master('warehouses',id,warehouseMasters);
        if(!warehouse||warehouse.active===false||warehouse.systemCustody
          ||warehouse.warehouseType==='CUSTODY'||id.startsWith('custody-'))continue;
        physical.push({...warehouse,id});
        totalAvailable+=stock.available;
        // The shared selector recomputes availability from stock fields, so
        // include reservations planned earlier in this same whole-order pass.
        stocks[id]={onHand:stock.onHand,reserved:stock.reserved+stock.delta,
          transferFreeInTransit:stock.transferFreeInTransit};
      }
      if(!physical.some(warehouse=>warehouse.id===preferredId))
        fault('failed-precondition','來源不是啟用的實體倉庫');
      if(aggregateAvailable>totalAvailable)
        fault('failed-precondition','公司可用庫存高於啟用分倉總可用量，請先核對庫存，避免誤列待採購');
      const selected=reservationCore.selectSingleWarehouse({
        warehouses:physical,stocks,currentWarehouseId:preferredId,
        requestedQty:requested,aggregateAvailableQty:aggregateAvailable
      });
      if(selected.requiresMultipleLocations)
        fault('failed-precondition','此品項需要多倉分配，請先調撥後重試；未提交任何預留或採購需求');
      return selected.warehouseId;
    }
    for(const [index,source] of order.items.entries()){
      if(!source||typeof source!=='object')fault('failed-precondition','訂單品項格式不正確');
      const itemId=ident(source.itemId||'item-'+(index+1),'品項 ID');
      if(seenItems.has(itemId))fault('failed-precondition','訂單品項 ID 重複');
      seenItems.add(itemId);
      const orderedQty=quantity(source.qty??source.orderedQty,'訂購量');
      if(['reservedQty','deliveredQty','returnedQty','supplyOrderedQty','receivedQty',
        'dispatchPreparedQty','warehouseShippedQty'].some(field=>quantity(source[field]??0,field)!==0)
        ||source.transferPendingId||source.custodyTransferId)
        fault('failed-precondition','僅支援尚未預留或履約的新訂單');
      const type=String(source.productType||'').toUpperCase();
      const fulfillmentType=source.fulfillmentType||order.fulfillmentType||'WAREHOUSE';
      if(!['WAREHOUSE','DIRECT_SHIP'].includes(fulfillmentType))
        fault('failed-precondition','品項履約方式不支援');
      const productId=source.productId?ident(source.productId,'產品主檔 ID',1500):'';
      const productKey=productKeyOf(source,productId);
      const product=productId?await master('products',productId,productMasters):null;
      const actualType=String(product?.productType||product?.type||'').toUpperCase();
      if(type==='SERVICE'&&(!product||product.active===false||actualType!=='SERVICE'))
        fault('failed-precondition','服務型品項與產品主檔不一致');
      if(type!=='SERVICE'&&actualType==='SERVICE')
        fault('failed-precondition','服務型產品不可冒充實貨');
      if(product?.active===false)fault('failed-precondition','產品主檔已停用');
      const service=type==='SERVICE',direct=fulfillmentType==='DIRECT_SHIP';
      if(service&&direct)fault('failed-precondition','服務型品項不支援原廠直送');
      let warehouseId=service||direct?'':ident(source.warehouseId||order.warehouseId,'實體倉庫',200);
      let reserve=0,shortage=0;
      if(!service&&!direct&&productKey){
        if(productId&&!product)fault('failed-precondition','來源品項缺少有效產品主檔');
        const aggregate=await trackedStock('inventory',encodeURIComponent(productKey),companyStocks,'公司');
        warehouseId=await chooseSingleWarehouse(productKey,warehouseId,orderedQty,aggregate.available);
        const warehouseKey=encodeURIComponent(warehouseId)+'__'+encodeURIComponent(productKey);
        const location=await trackedStock('warehouseStocks',warehouseKey,warehouseStocks,warehouseId,
          {warehouseId,productKey});
        reserve=Math.min(orderedQty,aggregate.available,location.available);
        aggregate.available-=reserve;aggregate.delta+=reserve;
        location.available-=reserve;location.delta+=reserve;
        shortage=orderedQty-reserve;
        const reservationRef=ref('inventoryReservations',orderId+'__'+itemId);
        const reservationSnap=await tx.get(reservationRef);
        if(reservationSnap.exists){
          const before=reservationSnap.data();
          if(quantity(before.quantity??0,'既有預留')!==0||before.orderId!==orderId
            ||before.itemId!==itemId||before.productKey!==productKey
            ||before.warehouseId!==warehouseId)
            fault('failed-precondition','已有舊預留帳，請先稽核');
          if(before.locationSchemaVersion!==undefined||before.locations!==undefined
            ||before.allocations!==undefined||before.warehouseAllocations!==undefined)
            fault('failed-precondition','已有多位置預留帳，必須另行稽核');
        }
        writes.push({type:'set',ref:reservationRef,data:{
          orderId,itemId,orderItemIndex:index,orderNo:order.orderNo||order.quoteNo||orderId,
          productKey,warehouseId,itemCode:source.itemCode||'',itemName:source.itemName||'',
          customerName:order.customerName||'',ownerUid:order.ownerUid,salesCode:order.salesCode,
          salesName:order.salesName||'',orderDate:order.orderDate||'',quantity:reserve,
          shortageQty:shortage,status:reserve>0?'active':'shortage',updatedAt:now}});
      }else if(!service&&!direct){
        // Manual products without a linked master are procurement-only.
        shortage=orderedQty;
      }
      const next={...source,itemId,orderedQty,reservedQty:reserve,shortageQty:shortage,
        inventoryProductKey:service||direct?'':productKey,warehouseId};
      if(service||direct)next.reservationStatus='not_required';
      if(!service&&!direct&&!productKey)next.reservationError='missing_product_master';
      nextItems.push(next);
      reservedQty+=reserve;shortageQty+=shortage;
      const demandId=demandCore.demandIdForSource({sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId});
      const demandRef=ref('procurementDemands',encodeURIComponent(demandId));
      const demandSnap=await tx.get(demandRef),prior=demandSnap.exists?demandSnap.data():null;
      if(prior){
        if(prior.demandId!==demandId||prior.sourceType!=='SALES_ORDER'
          ||prior.sourceId!==orderId||prior.sourceItemId!==itemId
          ||(prior.productKey!==undefined&&prior.productKey!==productKey)
          ||(prior.warehouseId!==undefined&&prior.warehouseId!==warehouseId)
          ||(prior.ownerUid!==undefined&&prior.ownerUid!==order.ownerUid)
          ||(prior.salesCode!==undefined&&prior.salesCode!==order.salesCode)
          ||prior.status==='CANCELLED'||quantity(prior.orderedQty??0,'已採購量')!==0
          ||quantity(prior.receivedQty??0,'已收貨量')!==0)
          fault('failed-precondition','既有採購需求已有承諾或來源不一致');
      }
      const projected=demandCore.fromSalesOrder({
        sourceId:orderId,sourceItemId:itemId,sourceItemIndex:index,
        productId,productKey,itemCode:source.itemCode||'',itemName:source.itemName||'',
        brand:source.brand||'',fulfillmentType,warehouseId,
        ownerUid:order.ownerUid,salesCode:order.salesCode,salesName:order.salesName||'',
        shortageQty:shortage,requiredSupplyQty:direct?orderedQty:0,
        supplyOrderedQty:0,receivedQty:0,
        scheduleDate:prior?.scheduleDate||source.requiredByDate||source.scheduleDate
          ||order.requiredByDate||order.expectedDate||''
      });
      const demandDoc=demandCore.demandDocument(projected,{createdAt:prior?.createdAt||order.createdAt||now,updatedAt:now});
      if(prior||demandDoc.requestedQty>0)writes.push({type:'set',ref:demandRef,data:demandDoc});
    }
    // The read phase is complete. Apply all writes only after validating the
    // entire order, including all supplier and existing-reservation records.
    for(const stock of companyStocks.values())if(stock.delta>0){
      if(!stock.exists)fault('failed-precondition','公司庫存主檔不足，不可增加預留');
      writes.push({type:'update',ref:stock.ref,data:{reserved:stock.reserved+stock.delta,updatedAt:now}});
    }
    for(const stock of warehouseStocks.values())if(stock.delta>0){
      if(!stock.exists)fault('failed-precondition','分倉庫存主檔不足，不可增加預留');
      writes.push({type:'update',ref:stock.ref,data:{reserved:stock.reserved+stock.delta,updatedAt:now}});
    }
    let movementIndex=0;
    for(const stock of warehouseStocks.values())if(stock.delta>0){
      writes.push({type:'create',ref:ref('inventoryMovements','order-sync-'+syncAttemptId+'-'+movementIndex++),
        data:{sourceType:'order',sourceId:orderId,productKey:stock.productKey,
          warehouseId:stock.warehouseId,type:'reserve',qty:stock.delta,
          actorUid:uid,actorRole:role,ownerUid:order.ownerUid,salesCode:order.salesCode,
          createdBy:user.name||user.displayName||user.email||uid,
          fulfillmentType:'WAREHOUSE',reason:'initial_order_reservation',
          createdAt:now,reservationOperationId:receiptRef.id}});
    }
    for(const write of writes){
      if(write.type==='set')tx.set(write.ref,write.data,{merge:true});
      else if(write.type==='update')tx.update(write.ref,write.data);
      else tx.create(write.ref,write.data);
    }
    // The receipt, stock, demand and source completion are one authoritative
    // result. A lost response must never leave a committed ledger marked pending.
    tx.update(orderRef,{items:nextItems,itemCount:nextItems.length,
      inventoryReservationStatus:'completed',inventoryReservationError:'',
      inventoryReservationUpdatedAt:now,...initialOrderWorkIndex(order,nextItems,now),updatedAt:now});
    tx.create(receiptRef,{action:'order_initial_reservation',orderId,syncAttemptId,
      actorUid:uid,actorRole:role,reservedQty,shortageQty,createdAt:now,status:'applied'});
    return {status:'applied',receiptId:receiptRef.id,reservedQty,shortageQty};
  });
}
module.exports={commitOrderReservation,normalizeOrderReservationIntent};
