'use strict';

// A single, retry-safe initial reservation writer for an entire new order.
// Unlike the former browser per-item transactions, every stock, reservation,
// purchase-demand and order-item projection commits together or not at all.
const {createHash}=require('node:crypto');
const demandCore=require('./shared/procurement-demand-core.js');
const fulfillmentCore=require('./shared/fulfillment-core.js');
const workflowCore=require('./shared/workflow-core.js');
const reservationCore=require('./shared/reservation-core.js');
const {hasCommercialOwnerIdentity}=require('./commercial-owner-identity');
const receivingCore=require('./shared/receiving-core');
const {sanitizeSupply}=require('./shared/stock-permissions');

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
  const incoming=quantity(value?.incoming??0,label+'採購在途');
  if(reserved+transferFreeInTransit>onHand)fault('failed-precondition',label+'庫存帳目不一致');
  return {onHand,reserved,transferFreeInTransit,incoming,
    available:onHand-reserved-transferFreeInTransit,delta:0,incomingDelta:0};
}
function selfOrderCost(value){
  if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>100000000
    ||Math.abs(Math.round(value*100)-value*100)>1e-6)
    fault('failed-precondition','自行訂貨成本必須為有效的非負兩位小數金額');
  return value;
}
function selfOrderDate(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)
    ||!Number.isFinite(Date.parse(value+'T00:00:00Z'))
    ||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)
    fault('failed-precondition','自行訂貨日期不正確');
  return value;
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
  if([order.status,order.orderStatus].some(status=>['cancelled','voided'].includes(status)))
    return {workCategories:['closed'],workCategoryUpdatedAt:now};
  const categories=[...new Set(items.flatMap((source,index)=>{
    const item=fulfillmentCore.normalizeItem(source,index);
    if(workflowCore.isServiceItem(item)&&order.serviceFulfillment)
      return [workflowCore.serviceItemWorkCategory(order,item)];
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

async function commitOrderReservation(db,uid,data,{allowInitialSelfOrder=false}={}){
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
      // Original supplier evidence is immutable even after valid receipt or
      // cancellation; a lone receipt must not acknowledge missing purchases.
      for(const evidence of receipt.selfOrderCommitments||[]){
        const supplySnap=await tx.get(ref('supplyOrders',evidence.supplyId));
        const operationSnap=await tx.get(ref('purchaseOperations',evidence.operationId));
        if(!supplySnap.exists||!operationSnap.exists
          ||supplySnap.data().sourceId!==orderId||supplySnap.data().sourceItemId!==evidence.itemId
          ||supplySnap.data().demandId!==evidence.demandId
          ||supplySnap.data().qty!==evidence.qty||operationSnap.data().supplyId!==evidence.supplyId
          ||operationSnap.data().uid!==uid)
          fault('failed-precondition','同步憑證與供應商承諾不一致');
      }
      return {status:'already-applied',receiptId:receiptRef.id,
        reservedQty:receipt.reservedQty,shortageQty:receipt.shortageQty};
    }
    const orderRef=ref('orders',orderId),orderSnap=await tx.get(orderRef);
    if(!orderSnap.exists)fault('not-found','來源訂單不存在');
    const order=orderSnap.data();
    if(!await hasCommercialOwnerIdentity(tx,db,uid,user,order)||!Array.isArray(order.items)
      ||order.items.length<1||order.items.length>50)
      fault('failed-precondition','訂單所有權、業務代碼或品項資料不完整');
    if(['cancelled','canceled','void','voided','deleted','completed','closed','已取消','作廢','已完成','結案']
      .some(value=>[order.status,order.orderStatus].some(status=>String(status||'').toLowerCase()===value)))
      fault('failed-precondition','已取消或結案訂單不可同步預留');
    if(order.inventoryReservationStatus!=='pending'||order.inventoryReservationAttemptId!==syncAttemptId)
      fault('failed-precondition','已有較新的庫存同步工作');
    if(['sales','engineer'].includes(role)&&order.ownerUid!==uid)
      fault('permission-denied','只能同步自己的訂單');
    const initialConfirmed=order.items.some(item=>
      (item?.procurementType||order.procurementType)==='SALES_SELF_ORDER'
      &&item?.selfOrderConfirmed===true);
    if(initialConfirmed&&!allowInitialSelfOrder)
      fault('failed-precondition','已確認自行訂貨後端尚未在此授權環境啟用');
    if(initialConfirmed&&(order.selfOrderAtCreation!==true||order.ownerUid!==uid
      ||!['sales','engineer'].includes(role)||order.items.length>5))
      fault('permission-denied','已確認自行訂貨僅限負責業務建立，且須符合正式收貨品項上限');

    const now=new Date().toISOString();
    const productMasters=new Map(),warehouseMasters=new Map();
    const companyStocks=new Map(),warehouseStocks=new Map(),warehouseCandidates=new Map();
    const writes=[],nextItems=[],seenItems=new Set(),lifecycleWarehouses=new Set();
    const commitments=[];
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
      // Keep the existing single-location allocation policy; persist its result
      // through the same v2 location contract used by fulfillment.
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
        lifecycleWarehouses.add(id);
        totalAvailable+=stock.available;
        // The shared selector recomputes availability from stock fields, so
        // include reservations planned earlier in this same whole-order pass.
        stocks[id]={onHand:stock.onHand,reserved:stock.reserved+stock.delta,
          transferFreeInTransit:stock.transferFreeInTransit};
      }
      if(!physical.some(warehouse=>warehouse.id===preferredId))
        fault('failed-precondition','來源不是啟用的實體倉庫');
      // A lower company balance is equally unsafe: it can hide physically
      // stocked units as shortages or initialize a zero company ledger over
      // an existing nonzero warehouse ledger. Never paper over either split.
      if(aggregateAvailable!==totalAvailable)
        fault('failed-precondition','公司可用庫存與啟用分倉總可用量不一致，請先核對庫存，避免錯誤預留或待採購');
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
      const type=String(source.productType||'').trim().toUpperCase();
      const fulfillmentType=source.fulfillmentType||order.fulfillmentType||'WAREHOUSE';
      if(!['WAREHOUSE','DIRECT_SHIP'].includes(fulfillmentType))
        fault('failed-precondition','品項履約方式不支援');
      const productId=source.productId?ident(source.productId,'產品主檔 ID',1500):'';
      const productKey=productKeyOf(source,productId);
      const product=productId?await master('products',productId,productMasters):null;
      const actualType=String(product?.productType||product?.type||'').trim().toUpperCase();
      if(type==='SERVICE'&&(!product||product.active===false||actualType!=='SERVICE'))
        fault('failed-precondition','服務型品項與產品主檔不一致');
      if(type!=='SERVICE'&&actualType==='SERVICE')
        fault('failed-precondition','服務型產品不可冒充實貨');
      if(product?.active===false)fault('failed-precondition','產品主檔已停用');
      const service=type==='SERVICE',direct=fulfillmentType==='DIRECT_SHIP';
      if(service&&direct)fault('failed-precondition','服務型品項不支援原廠直送');
      const confirmed=(source.procurementType||order.procurementType)==='SALES_SELF_ORDER'
        &&source.selfOrderConfirmed===true;
      if(confirmed&&(service||!productId||!product||!productKey))
        fault('failed-precondition','自行訂貨須綁定有效實體產品主檔');
      let warehouseId=service||direct?'':ident(source.warehouseId||order.warehouseId,'實體倉庫',200);
      let reserve=0,shortage=0;
      if(!service&&!direct&&productKey){
        if(productId&&!product)fault('failed-precondition','來源品項缺少有效產品主檔');
        const aggregate=await trackedStock('inventory',encodeURIComponent(productKey),companyStocks,'公司');
        if(productId&&!aggregate.exists){
          aggregate.productId=productId;
          aggregate.itemCode=source.itemCode||'';
          aggregate.itemName=source.itemName||'';
          aggregate.brand=source.brand||'';
          aggregate.brandId=source.brandId||'';
        }
        warehouseId=await chooseSingleWarehouse(productKey,warehouseId,orderedQty,aggregate.available);
        const warehouseKey=encodeURIComponent(warehouseId)+'__'+encodeURIComponent(productKey);
        const location=await trackedStock('warehouseStocks',warehouseKey,warehouseStocks,warehouseId,
          {warehouseId,productKey});
        if(productId&&!location.exists){
          location.productId=productId;
          location.itemCode=source.itemCode||'';
          location.itemName=source.itemName||'';
          location.brand=source.brand||'';
          location.brandId=source.brandId||'';
        }
        const reservationRef=ref('inventoryReservations',orderId+'__'+itemId);
        const reservationSnap=await tx.get(reservationRef);
        // Replays have already returned the original operation receipt. A new
        // initialization must never adopt or convert an older reservation.
        if(reservationSnap.exists)
          fault('failed-precondition','已有預留帳，請先稽核；新建單不得轉換舊交易');
        const locationPlan=reservationCore.planLocationReservation({
          productKey,warehouses:[{id:warehouseId,active:true}],
          stocks:{[warehouseId]:{productKey,warehouseId,onHand:location.onHand,
            reserved:location.reserved+location.delta,
            transferFreeInTransit:location.transferFreeInTransit}},
          aggregateStock:{productKey,onHand:aggregate.onHand,
            reserved:aggregate.reserved+aggregate.delta,
            transferFreeInTransit:aggregate.transferFreeInTransit},
          requestedQty:orderedQty,currentWarehouseId:warehouseId,itemReservedQty:0
        });
        reserve=locationPlan.reservation.quantity;shortage=locationPlan.reservation.shortageQty;
        aggregate.available-=locationPlan.companyReservedDelta;
        aggregate.delta+=locationPlan.companyReservedDelta;
        for(const change of locationPlan.warehouseDeltas){
          if(change.warehouseId!==warehouseId)
            fault('failed-precondition','新單預留核心回傳未授權位置');
          location.available-=change.reservedDelta;location.delta+=change.reservedDelta;
        }
        writes.push({type:'set',ref:reservationRef,data:{
          orderId,itemId,orderItemIndex:index,orderNo:order.orderNo||order.quoteNo||orderId,
          productKey,itemCode:source.itemCode||'',itemName:source.itemName||'',
          customerName:order.customerName||'',ownerUid:order.ownerUid,salesCode:order.salesCode,
          salesName:order.salesName||'',orderDate:order.orderDate||'',
          ...locationPlan.reservation,updatedAt:now}});
      }else if(!service&&!direct){
        // Manual products without a linked master are procurement-only.
        shortage=orderedQty;
      }
      const commitQty=confirmed?(direct?orderedQty:shortage):0;
      let commitment=null;
      if(commitQty>0){
        const supplier=ident(source.supplier,'自行訂貨供應商',200);
        const unitCost=selfOrderCost(source.costPrice);
        const date=selfOrderDate(order.orderDate);
        const supplyId='self-'+encodeURIComponent(orderId)+'-'+encodeURIComponent(itemId);
        const operationId='so-'+createHash('sha256')
          .update(JSON.stringify([orderId,syncAttemptId,itemId])).digest('hex').slice(0,40);
        const operationDocId='self-'+operationId;
        const supplyRef=ref('supplyOrders',supplyId);
        const operationRef=ref('purchaseOperations',operationDocId);
        const receivingRef=ref('receivingSupplyOrders',supplyId);
        const movementRef=ref('inventoryMovements',operationDocId);
        const [priorSupply,priorOperation,priorReceiving,priorMovement]=await Promise.all([
          tx.get(supplyRef),tx.get(operationRef),tx.get(receivingRef),tx.get(movementRef)]);
        if(priorSupply.exists||priorOperation.exists||priorReceiving.exists||priorMovement.exists)
          fault('failed-precondition','自行訂貨已有供應或操作憑證，禁止建立重複承諾');
        const internalNo='SO-'+date.replace(/-/g,'')+'-'+supplyId.slice(-8).toUpperCase();
        commitment={itemId,index,qty:commitQty,supplier,unitCost,date,internalNo,
          supplyId,operationId,operationDocId,supplyRef,operationRef,receivingRef,movementRef,
          warehouseId,productId,productKey,fulfillmentType};
        commitments.push(commitment);
        if(!direct){
          const company=await trackedStock('inventory',encodeURIComponent(productKey),companyStocks,'公司');
          const location=await trackedStock('warehouseStocks',
            encodeURIComponent(warehouseId)+'__'+encodeURIComponent(productKey),warehouseStocks,warehouseId,
            {warehouseId,productKey});
          company.incomingDelta+=commitQty;location.incomingDelta+=commitQty;
        }
      }
      const next={...source,itemId,orderedQty,reservedQty:reserve,shortageQty:shortage,
        inventoryProductKey:service||direct?'':productKey,warehouseId};
      if(commitment){
        next.supplyOrderedQty=commitQty;
        next.selfOrderNos=[...new Set([...(source.selfOrderNos||[]),commitment.internalNo])];
        next.supplier=commitment.supplier;
        next.orderedAt=commitment.date;
        next.orderEvents=[...(source.orderEvents||[]),{
          id:commitment.operationDocId,type:'SALES_SELF_ORDER',at:now,date:commitment.date,
          qty:commitQty,documentNo:commitment.internalNo,by:user.name||uid}];
      }
      // An untyped physical line must not inherit a service order's summary type.
      if(!type&&workflowCore.isServiceItem(order))next.productType='Goods';
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
      if(service){
        if(prior)fault('failed-precondition','服務品項不可綁定實體採購需求');
        continue;
      }
      const projected=demandCore.fromSalesOrder({
        sourceId:orderId,sourceItemId:itemId,sourceItemIndex:index,
        productId,productKey,itemCode:source.itemCode||'',itemName:source.itemName||'',
        brand:source.brand||'',fulfillmentType,warehouseId,
        ownerUid:order.ownerUid,salesCode:order.salesCode,salesName:order.salesName||'',
        shortageQty:shortage,requiredSupplyQty:direct?orderedQty:0,
        supplyOrderedQty:commitQty,receivedQty:0,
        scheduleDate:prior?.scheduleDate||source.requiredByDate||source.scheduleDate
          ||order.requiredByDate||order.expectedDate||''
      });
      const demandDoc=demandCore.demandDocument(projected,{createdAt:prior?.createdAt||order.createdAt||now,updatedAt:now});
      if(prior||demandDoc.requestedQty>0)writes.push({type:'set',ref:demandRef,data:demandDoc});
    }
    const lifecycleWarehouseIds=[...lifecycleWarehouses].sort();
    if(lifecycleWarehouseIds.length>2)
      fault('failed-precondition','新單生命週期目前僅支援 1–2 個候選實體倉，未提交任何預留');
    // Every v2 consumer needs an explicit zero balance for each candidate,
    // including a product that has never been stocked at a sibling's warehouse.
    // Missing stock was already treated as zero during reservation planning;
    // make that fact durable in the same transaction, never infer real stock.
    for(const [companyDocumentId,company] of companyStocks){
      // Cache keys are encoded document IDs; stock fields retain the raw product identity.
      const productKey=decodeURIComponent(companyDocumentId);
      if(!company.exists)writes.push({type:'create',ref:company.ref,data:{
        productKey,productId:company.productId||'',itemCode:company.itemCode||'',
        itemName:company.itemName||'',brand:company.brand||'',brandId:company.brandId||'',
        onHand:0,reserved:0,incoming:company.incomingDelta,updatedAt:now}});
      for(const warehouseId of lifecycleWarehouseIds){
        const key=encodeURIComponent(warehouseId)+'__'+encodeURIComponent(productKey);
        const stock=await trackedStock('warehouseStocks',key,warehouseStocks,warehouseId,{warehouseId,productKey});
        if(!stock.exists)writes.push({type:'create',ref:stock.ref,data:{
          productKey,productId:stock.productId||company.productId||'',warehouseId,
          itemCode:stock.itemCode||company.itemCode||'',itemName:stock.itemName||company.itemName||'',
          brand:stock.brand||company.brand||'',brandId:stock.brandId||company.brandId||'',
          onHand:0,reserved:0,incoming:stock.incomingDelta,updatedAt:now}});
      }
    }
    for(const write of writes)if(write.ref.path.startsWith('inventoryReservations/'))
      write.data.lifecycleWarehouseIds=lifecycleWarehouseIds;
    // The read phase is complete. Apply all writes only after validating the
    // entire order, including all supplier and existing-reservation records.
    for(const stock of companyStocks.values())if(stock.delta>0||stock.incomingDelta>0){
      if(!stock.exists){
        if(stock.delta>0)fault('failed-precondition','公司庫存主檔不足，不可增加預留');
        continue;
      }
      writes.push({type:'update',ref:stock.ref,data:{reserved:stock.reserved+stock.delta,
        incoming:stock.incoming+stock.incomingDelta,updatedAt:now}});
    }
    for(const stock of warehouseStocks.values())if(stock.delta>0||stock.incomingDelta>0){
      if(!stock.exists){
        if(stock.delta>0)fault('failed-precondition','分倉庫存主檔不足，不可增加預留');
        continue;
      }
      writes.push({type:'update',ref:stock.ref,data:{reserved:stock.reserved+stock.delta,
        incoming:stock.incoming+stock.incomingDelta,updatedAt:now}});
    }
    for(const c of commitments){
      const source=order.items[c.index];
      const demandId=demandCore.demandIdForSource({sourceType:'SALES_ORDER',sourceId:orderId,
        sourceItemId:c.itemId});
      const event={operationId:c.operationId,qty:c.qty,supplier:c.supplier,unitCost:c.unitCost,
        orderDate:c.date,notes:'',createdAt:now,createdByUid:uid,createdBy:user.name||uid};
      const supply={type:'SALES_SELF_ORDER',method:'SALES_SELF_ORDER',sourceType:'SALES_ORDER',
        sourceId:orderId,sourceItemId:c.itemId,demandId,internalNo:c.internalNo,
        orderId,itemId:c.itemId,orderItemIndex:c.index,ownerUid:order.ownerUid,
        salesCode:order.salesCode,salesName:order.salesName||'',customerName:order.customerName||'',
        company:order.company||'',productId:c.productId,productKey:c.productKey,
        itemCode:source.itemCode||'',itemName:source.itemName||'',brand:source.brand||'',
        brandId:source.brandId||'',productLine:source.productLine||'',qty:c.qty,receivedQty:0,
        incomingRegisteredQty:c.fulfillmentType==='DIRECT_SHIP'?0:c.qty,
        incomingRegisteredAt:c.fulfillmentType==='DIRECT_SHIP'?'':now,
        supplier:c.supplier,unitCost:c.unitCost,notes:'',orderDate:c.date,lastOrderedAt:c.date,
        orderEvents:[event],fulfillmentType:c.fulfillmentType,warehouseId:c.warehouseId,
        createdAt:now,updatedAt:now,createdByUid:uid,createdBy:user.name||uid,createdByRole:role};
      supply.status=receivingCore.normalizeSupply(supply).status;
      writes.push({type:'create',ref:c.supplyRef,data:supply});
      writes.push({type:'create',ref:c.receivingRef,data:sanitizeSupply(supply)});
      const purchaseIntent={operationId:c.operationId,orderId,itemId:c.itemId,qty:c.qty,
        supplier:c.supplier,unitCost:c.unitCost,orderDate:c.date,notes:''};
      writes.push({type:'create',ref:c.operationRef,data:{type:'SALES_SELF_ORDER',
        operationId:c.operationId,uid,supplyId:c.supplyId,demandId,orderId,itemId:c.itemId,
        hash:createHash('sha256').update(JSON.stringify(purchaseIntent)).digest('hex'),
        qty:c.qty,movementId:c.fulfillmentType==='DIRECT_SHIP'?'':c.movementRef.id,
        createdAt:now}});
      if(c.fulfillmentType!=='DIRECT_SHIP')writes.push({type:'create',ref:c.movementRef,
        data:{type:'purchase_incoming',qty:c.qty,productKey:c.productKey,productId:c.productId,
          warehouseId:c.warehouseId,brand:source.brand||'',brandId:source.brandId||'',
          fulfillmentType:'WAREHOUSE',sourceType:'SUPPLY_ORDER',sourceId:c.supplyId,
          purchaseDocumentId:c.internalNo,createdAt:now,createdBy:user.name||uid,actorUid:uid,
          ownerUid:order.ownerUid,salesCode:order.salesCode}});
    }
    const movementPrefix='order-sync-'+createHash('sha256')
      .update(JSON.stringify([orderId,syncAttemptId])).digest('hex');
    let movementIndex=0;
    for(const stock of warehouseStocks.values())if(stock.delta>0){
      writes.push({type:'create',ref:ref('inventoryMovements',movementPrefix+'-'+movementIndex++),
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
    const serviceEnabled=db.projectId!=='yu-shing-company'
      ||require('./service-case-gate').serviceCaseBackendProject()===db.projectId;
    const serviceFields=serviceEnabled&&nextItems.some(workflowCore.isServiceItem)?{serviceFulfillment:{}}:{};
    const indexedOrder={...order,...serviceFields};
    tx.update(orderRef,{...serviceFields,items:nextItems,itemCount:nextItems.length,
      inventoryReservationStatus:'completed',inventoryReservationError:'',
      inventoryReservationUpdatedAt:now,...initialOrderWorkIndex(indexedOrder,nextItems,now),updatedAt:now});
    tx.create(receiptRef,{action:'order_initial_reservation',orderId,syncAttemptId,
      actorUid:uid,actorRole:role,reservedQty,shortageQty,
      selfOrderCommitments:commitments.map(c=>({supplyId:c.supplyId,operationId:c.operationDocId,
        demandId:demandCore.demandIdForSource({sourceType:'SALES_ORDER',sourceId:orderId,
          sourceItemId:c.itemId}),itemId:c.itemId,qty:c.qty})),createdAt:now,status:'applied'});
    return {status:'applied',receiptId:receiptRef.id,reservedQty,shortageQty};
  });
}
module.exports={commitOrderReservation,normalizeOrderReservationIntent,initialOrderWorkIndex};
