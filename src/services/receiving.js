// Transaction layer only. Optional synchronous observers report committed locations;
// callers own cache invalidation and presentation. Never notify from a transaction callback.
async function allocateFreeReceiptStockToShortages(productKey,warehouseId,maxQty,actor,excludeOrderId='',receiptId='',checkpointCollection='receipts',allocationGuard=null,onStockCommitted=null) {
    allocationGuard?.();
    if(!['receipts','stockTransfers'].includes(checkpointCollection))throw new Error('庫存分配進度來源不正確。');
    let remaining=Math.max(0,Number(maxQty||0)),allocatedQty=0;
    const affectedOrderIds = new Set();
    const skippedCandidateIds = new Set();
    let completionReason='exhausted';
    if(!remaining||!productKey||!warehouseId)return {allocatedQty:0,unallocatedQty:remaining,affectedOrderIds:[]};
    const compare=globalThis.YushinReservation?.compareReservationPriority;
    if(!compare)throw new Error('庫存分配核心未載入，請重新載入後重試分配。');
    // Allocate one live shortage at a time. Re-reading candidates after every successful
    // transaction preserves oldest-first ordering even when multiple receipts run concurrently.
    // 已失效／取消的最舊候選只跳過，不可阻塞後面的正常缺貨訂單。
    while(remaining>0){
        allocationGuard?.();
        const oldestCandidate=async status=>{
            let candidate=null,cursor=null;
            while(true){
                let q=db.collection('inventoryReservations').where('productKey','==',productKey).where('status','==',status).limit(50);
                if(cursor)q=q.startAfter(cursor);
                const page=await firestoreReadWithTimeout(q.get(),'庫存預留候選');
                allocationGuard?.();
                for(const doc of page.docs){
                    const row={...doc.data(),id:doc.id};
                    if(row.orderId===excludeOrderId||row.warehouseId!==warehouseId||!(Number(row.shortageQty||0)>0)||skippedCandidateIds.has(row.id))continue;
                    if(!candidate||compare(row,candidate)<0)candidate=row;
                }
                if(page.size<50)break;
                const last=page.docs[page.docs.length-1];
                if(!last||last.id===cursor?.id)throw new Error('庫存預留分頁未前進，請重新載入後重試分配。');
                cursor=last;
            }
            return candidate;
        };
        const candidates=await Promise.all([oldestCandidate('shortage'),oldestCandidate('active')]);
        allocationGuard?.();
        const candidate=candidates.filter(Boolean).sort(compare)[0];
        if(!candidate){completionReason='no-demand';break;}
        let took=0,skipCandidate=false,stopAllocation=false;
        const allocationTime=new Date().toISOString();
        const movementRef=db.collection('inventoryMovements').doc();
        await runRoleTransaction(async tx=>{
            took=0;skipCandidate=false;stopAllocation=false;
            allocationGuard?.();
            const orderRef=db.collection('orders').doc(candidate.orderId);
            const reservationRef=db.collection('inventoryReservations').doc(candidate.id);
            const invRef=db.collection('inventory').doc(encodeURIComponent(productKey));
            const whRef=db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,productKey));
            const receiptRef=receiptId?db.collection(checkpointCollection).doc(receiptId):null;
            const demandId=globalThis.YushinProcurementDemand.demandIdForSource({sourceType:'SALES_ORDER',sourceId:candidate.orderId,sourceItemId:candidate.itemId});
            const demandRef=procurementDemandRef(demandId);
            const [orderSnap,resSnap,invSnap,whSnap,receiptSnap]=await Promise.all([
                tx.get(orderRef),tx.get(reservationRef),tx.get(invRef),tx.get(whRef),
                receiptRef?tx.get(receiptRef):Promise.resolve(null)
            ]);
            const demandSnap=await tx.get(demandRef);
            allocationGuard?.();
            if(!orderSnap.exists||!resSnap.exists||!whSnap.exists||!invSnap.exists){skipCandidate=true;return;}
            if(receiptRef&&!receiptSnap?.exists){completionReason='deferred';stopAllocation=true;return;}
            const reservation=resSnap.data();
            if(reservation.productKey!==productKey||reservation.warehouseId!==warehouseId){skipCandidate=true;return;}
            const liveShortage=Math.max(0,Number(reservation.shortageQty||0));
            const order={id:orderSnap.id,...orderSnap.data()};
            if(normalizedOrderStatus(order)!=='normal'||orderInventorySyncIncomplete(order)||liveShortage<=0){skipCandidate=true;return;}
            const receipt=receiptSnap?.exists?(receiptSnap.data()||{}):null;
            const receiptTarget=receiptRef?Math.max(0,Number(receipt?.autoAllocationQty||0)):remaining;
            const receiptAllocated=receiptRef?Math.max(0,Number(receipt?.autoAllocatedQty||0)):0;
            const receiptRemaining=receiptRef?Math.max(0,receiptTarget-receiptAllocated):remaining;
            const items=normalizedOrderItems(order);
            const index=items.findIndex(item=>item.itemId===reservation.itemId);
            if(index<0){skipCandidate=true;return;}
            const item=items[index],oldReserved=Number(item.reservedQty||0);
            if(inventoryProductKey(item)!==productKey||item.warehouseId!==warehouseId||item.transferPendingId||(item.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'){skipCandidate=true;return;}
            const oldShortage=Math.max(0,Number(item.shortageQty??liveShortage));
            // 已向供應商下訂的缺口不能再占用補貨，否則現貨與待到貨重複涵蓋同一需求。
            if(Math.abs(oldReserved-Number(reservation.quantity||0))>1e-9||Math.abs(oldShortage-liveShortage)>1e-9)throw new Error('訂單與庫存預留數量不一致，請由管理員檢查後重試。');
            const uncovered=remainingProcurementQty(order,item);
            if(uncovered<=0){skipCandidate=true;return;}
            const stockPlan=globalThis.YushinReservation.planReservationReceipt({productKey,warehouseId,
                qty:Math.min(remaining,receiptRemaining),requestedReserveQty:uncovered,addsStock:false,
                reservation,aggregateStock:invSnap.data(),warehouseStock:whSnap.data(),itemReservedQty:order.items[index].reservedQty});
            const take=stockPlan.allocatedQty;
            if(take<=0){completionReason='exhausted';stopAllocation=true;return;}
            items[index]={...item,reservedQty:stockPlan.reservation.quantity,shortageQty:stockPlan.reservation.shortageQty};
            const now=allocationTime;
            const nextOrder={...order,items,updatedAt:now};
            tx.update(orderRef,{items,...orderWorkIndexFields(nextOrder),updatedAt:now});
            const demand=procurementDemandForOrderItem(nextOrder,items[index]);
            tx.set(demandRef,procurementDemandDocument({...(demandSnap.exists?demandSnap.data():{}),...demand},{
                sourceItemIndex:index,productId:item.productId||'',productKey,
                itemCode:item.itemCode||'',itemName:item.itemName||'',brand:item.brand||'',
                fulfillmentType:'WAREHOUSE',warehouseId,ownerUid:order.ownerUid||'',
                salesCode:order.salesCode||'',salesName:order.salesName||''
            },{createdAt:demandSnap.exists?demandSnap.data().createdAt:order.createdAt||now,updatedAt:now}),{merge:true});
            tx.update(reservationRef,{...stockPlan.reservation,updatedAt:now});
            if(invSnap.exists)tx.update(invRef,{reserved:stockPlan.aggregateStock.reserved,updatedAt:now});
            tx.update(whRef,{reserved:stockPlan.warehouseStock.reserved,updatedAt:now});
            if(receiptRef){
                const nextAllocated=receiptAllocated+take;
                tx.update(receiptRef,{
                    autoAllocatedQty:nextAllocated,
                    allocationCompleted:nextAllocated>=receiptTarget,
                    allocationUpdatedAt:now
                });
            }
            tx.set(movementRef,inventoryMovementRecord(allocationGuard&&!receiptId?'reserve_from_free_stock':'reserve_from_receipt',take,candidate.orderId,productKey,actor,{
                warehouseId,itemId:reservation.itemId||'',fulfillmentType:'WAREHOUSE',createdAt:now,
                ownerUid:order.ownerUid||'',salesCode:order.salesCode||'',
                ...(checkpointCollection==='receipts'?{receiptId:receiptId||''}:{transferId:receiptId||''})
            }));
            took=take;
        });
        allocationGuard?.();
        if(took>0){onStockCommitted?.(productKey,warehouseId);allocatedQty+=took;remaining-=took;affectedOrderIds.add(candidate.orderId);continue;}
        if(skipCandidate){
            // 避免同一輪一直選到已取消／失效的舊 reservation；改看下一個候選。
            skippedCandidateIds.add(candidate.id);
            continue;
        }
        if(stopAllocation)break;
        break;
    }
    return {allocatedQty,unallocatedQty:remaining,affectedOrderIds:[...affectedOrderIds],completionReason};
}

// Reuse this receiving Service for the v2 trial; never create another receipt
// writer. The browser path stays closed until its backend/Rules adapters exist.
async function assertV2ReceiptActor(transaction, actorUid, actorRole) {
    if(typeof process==='undefined'||!process.env?.FIRESTORE_EMULATOR_HOST||db.projectId!=='demo-yushin')
        throw new Error('多倉收貨目前僅允許 demo-yushin Emulator，尚未開放正式入口。');
    const actor=await transaction.get(db.collection('users').doc(actorUid));
    if(!actor.exists||actor.data().active===false||actor.data().disabled===true
        ||actor.data().role!==actorRole||!['admin','purchaser','warehouse'].includes(actorRole))
        throw new Error('真實登入角色無此多倉收貨權限。');
}
async function validateV2ReceiptSource(transaction, {order,supply,reservation,item,inventory,warehouseStock,demand,actorUid,actorRole,qty}) {
    await assertV2ReceiptActor(transaction,actorUid,actorRole);
    const integer=(value,label)=>{
        if(!Number.isSafeInteger(value)||value<0)throw new Error(label+'必須是非負整數。');
        return value;
    };
    const id=value=>{
        if(typeof value!=='string'||!value||value!==value.trim()||value.includes('/')||value.length>160)
            throw new Error('多倉收貨來源識別不正確。');
        return value;
    };
    const orderId=id(supply.orderId),itemId=id(supply.itemId),productKey=id(supply.productKey),warehouseId=id(supply.warehouseId);
    const status=normalizedOrderStatus(order),cancelled=status==='cancelled';
    if(!Array.isArray(order.items)||!order.items.length||order.items.length>5
        ||order.items.filter(row=>row?.itemId===itemId).length!==1
        ||!order.ownerUid||!order.salesCode||!['normal','cancelled'].includes(status)
        ||(cancelled?order.status!=='cancelled':!['active','normal'].includes(order.status))
        ||!['normal','active','cancelled','',undefined].includes(order.orderStatus)
        ||order.returnPending===true||item.transferPendingId||item.custodyTransferId
        ||integer(order.logisticsTransfersPending??0,'調撥途中')!==0)
        throw new Error('多倉收貨只支援來源完整且無調撥的 1–5 品項訂單。');
    for(const field of ['warehouseShipmentRecords','deliveryRecords','returnRecords','returnHistory']){
        if(!Array.isArray(order[field]??[]))throw new Error('多倉收貨履約紀錄格式不正確。');
    }
    let jointHolds=null,wholeShipment=null;
    if(order.items.length>1){
        // Validate the whole event set before selecting the receiving line.
        // A sibling acknowledgement is never this line's outstanding demand.
        if(order.inventoryReservationStatus!=='completed'||!order.inventoryReservationAttemptId)
            throw new Error('多品項收貨僅支援已完成初始化的訂單。');
        wholeShipment=globalThis.YushinFulfillment.projectOrderShipmentReturns({orderId,items:order.items,
            shipments:order.warehouseShipmentRecords??[],deliveries:order.deliveryRecords??[],returns:order.returnRecords??[]});
        if((order.warehouseShipmentRecords??[]).length>40)
            throw new Error('多品項歷史出貨憑證超過本試點安全上限。');
        const seen=new Set(),products=new Map();
        jointHolds={company:0,warehouses:new Map()};
        const candidates=reservation.lifecycleWarehouseIds;
        if(!Array.isArray(candidates)||candidates.length!==2||new Set(candidates).size!==2)
            throw new Error('整單原候選倉資料不正確。');
        candidates.forEach(id);
        for(const row of order.items){
  if(String(row.productType||row.type||'').trim().toUpperCase()==='SERVICE')continue;
            const rowId=id(row?.itemId),productId=id(row.productId),key=id(row.inventoryProductKey||productId);
            const ordered=integer(row.qty??row.orderedQty,'品項訂購量');
            if(seen.has(rowId)||!ordered||(row.orderedQty!==undefined&&row.orderedQty!==ordered)
                ||(row.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'
                ||String(row.productType||row.type||'').toUpperCase()==='SERVICE'
                ||row.transferPendingId||row.custodyTransferId||!candidates.includes(id(row.warehouseId||order.warehouseId)))
                throw new Error('多品項收貨來源必須是唯一實體商品且無調撥途中。');
            seen.add(rowId);
            if(!products.has(productId))products.set(productId,await transaction.get(db.collection('products').doc(productId)));
            const product=products.get(productId);
            if(!product.exists||product.data().active===false||String(product.data().productType||product.data().type||'').toUpperCase()==='SERVICE')
                throw new Error('服務或停用商品不可進行多品項實貨收貨。');
            const snap=rowId===itemId?null:await transaction.get(db.collection('inventoryReservations').doc(`${orderId}__${rowId}`));
            const ledger=rowId===itemId?reservation:(snap.exists?snap.data():{});
            if(ledger.locationSchemaVersion!==2||ledger.warehouseId!==undefined||ledger.orderId!==orderId||ledger.itemId!==rowId
                ||ledger.productKey!==key||ledger.ownerUid!==order.ownerUid||ledger.salesCode!==order.salesCode
                ||!Array.isArray(ledger.lifecycleWarehouseIds)||ledger.lifecycleWarehouseIds.length!==2
                ||new Set(ledger.lifecycleWarehouseIds).size!==2||ledger.lifecycleWarehouseIds.some(wh=>!candidates.includes(wh))
                ||integer(ledger.quantity,'品項預留')!==row.reservedQty||integer(ledger.shortageQty,'品項缺口')!==row.shortageQty
                ||ledger.status!==(cancelled?'released':ledger.quantity>0?'active':ledger.shortageQty>0?'shortage':'fulfilled')
                ||integer(row.supplyOrderedQty??0,'品項供應量')<integer(row.receivedQty??0,'品項收貨量'))
                throw new Error('多品項收貨的完整預留來源或供應投影不一致。');
            const projection=wholeShipment.items.find(part=>part.itemId===rowId);
            if(integer(row.warehouseShippedQty??0,'品項出貨')!==projection.shippedQty
                ||integer(row.deliveredQty??0,'品項交付')!==projection.confirmedQty
                ||integer(row.returnedQty??0,'品項退貨')!==projection.returnedQty
                ||integer(row.dispatchPreparedQty??0,'品項打單')<projection.shippedQty
                ||integer(row.dispatchPreparedQty??0,'品項打單')>ordered
                ||(cancelled
                    ?ledger.quantity!==0||ledger.shortageQty!==0
                        ||globalThis.YushinReservation.reservationLocations(ledger).length!==0
                        ||projection.pendingDeliveryQty!==0||(row.dispatchPreparedQty??0)!==projection.shippedQty
                    :ledger.quantity+ledger.shortageQty!==projection.outstandingQty))
                throw new Error('多品項收貨預留與來源剩餘需求不一致。');
            const held=globalThis.YushinReservation.reservationStockDeltas({},ledger);
            if(held.warehouseDeltas.some(change=>!candidates.includes(change.warehouseId)))
                throw new Error('多品項預留不在原候選倉。');
            if(key===productKey){
                jointHolds.company+=held.companyReservedDelta;
                for(const change of held.warehouseDeltas)jointHolds.warehouses.set(change.warehouseId,
                    (jointHolds.warehouses.get(change.warehouseId)||0)+change.reservedDelta);
            }
        }
    }
    const returns=order.returnRecords??[];
    if((order.returnHistory??[]).some(event=>event?.action!=='add'||!returns.some(record=>record.id===event.recordId)))
        throw new Error('退貨歷史含尚未整合的更正或缺少原入庫來源。');
    const warehouseShipmentContext={orderId,itemId,productKey,
        shipments:wholeShipment?(order.warehouseShipmentRecords??[]).filter(row=>row.itemId===itemId):order.warehouseShipmentRecords??[],
        deliveries:wholeShipment?(order.deliveryRecords??[]).filter(row=>row.itemId===itemId):order.deliveryRecords??[],
        returns:wholeShipment?returns.filter(row=>row.itemId===itemId):returns};
    const shipment=wholeShipment?wholeShipment.items.find(part=>part.itemId===itemId):
        globalThis.YushinFulfillment.projectShipmentReturns({...warehouseShipmentContext,orderedQty:item.qty??item.orderedQty});
    // Empty caches must also match the actual bounded return query. Otherwise
    // removing a cached event could hide a physical receipt from this transaction.
    const proofs=await transaction.get(db.collection('inventoryMovements').where('sourceId','==',orderId)
        .where('action','==','location_customer_return').limit(201));
    await globalThis.YushinFulfillment.validateOrderLocationReturnProofs({...order,returnRecords:returns},
        {orderId,itemId,syncAttemptId:order.inventoryReservationAttemptId},productKey,
        proofs.docs.map(s=>({id:s.id,data:s.data()})),{closedOnly:true,hashIntent:async intent=>{
            const digest=await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(intent)));
            return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
        }});
    if(integer(item.warehouseShippedQty??0,'出貨量')!==shipment.shippedQty
        ||integer(item.deliveredQty??0,'交付量')!==shipment.confirmedQty
        ||integer(order.deliveredQty??0,'訂單交付量')!==(wholeShipment??shipment).confirmedQty
        ||integer(item.returnedQty??0,'退貨量')!==shipment.returnedQty
        ||integer(order.returnedQty??0,'訂單退貨量')!==(wholeShipment??shipment).returnedQty
        ||(order.isDelivered??false)!==(wholeShipment??shipment).isDelivered)
        throw new Error('多倉收貨的出貨、送達或退貨投影不一致。');
    for(const record of wholeShipment?(order.warehouseShipmentRecords??[]):warehouseShipmentContext.shipments){
        // Read every immutable debit in this transaction so a stale or forged
        // source cannot reduce the quantity awaiting reservation.
        if(record.movementId!=='location-ship-'+record.id)throw new Error('來源倉庫出貨憑證不一致。');
        const proof=await transaction.get(db.collection('inventoryMovements').doc(record.movementId));
        globalThis.YushinFulfillment.validateShipmentMovement(record,proof.exists?proof.data():null,
            wholeShipment?{orderId,itemId:record.itemId,productKey:record.productKey}:{orderId,itemId,productKey});
    }
    const demandId=globalThis.YushinProcurementDemand.demandIdForSource({sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId});
    if(supply.sourceType!=='SALES_ORDER'||supply.sourceId!==orderId||supply.sourceItemId!==itemId
        ||supply.demandId!==demandId||supply.ownerUid!==order.ownerUid||supply.salesCode!==order.salesCode
        ||supply.productId!==item.productId||supply.fulfillmentType!=='WAREHOUSE'
        ||(supply.method!==undefined&&supply.method!==supply.type)
        ||!demand||demand.demandId!==demandId||demand.sourceType!=='SALES_ORDER'
        ||demand.sourceId!==orderId||demand.sourceItemId!==itemId||demand.productKey!==productKey
        ||demand.productId!==item.productId||demand.ownerUid!==order.ownerUid||demand.salesCode!==order.salesCode
        ||demand.fulfillmentType!=='WAREHOUSE'
        ||reservation.orderId!==orderId||reservation.itemId!==itemId||reservation.productKey!==productKey
        ||reservation.ownerUid!==order.ownerUid||reservation.salesCode!==order.salesCode
        ||reservation.warehouseId!==undefined)
        throw new Error('多倉收貨的訂單、需求或預留來源不一致。');
    integer(qty,'本次收貨');
    const held=integer(reservation.quantity,'預留'),shortage=integer(reservation.shortageQty,'缺口');
    const ordered=integer(item.qty??item.orderedQty,'訂購量');
    const supplied=integer(item.supplyOrderedQty??0,'供應量'),received=integer(item.receivedQty??0,'收貨量');
    const supplyQty=integer(supply.qty,'來源採購量'),supplyReceived=integer(supply.receivedQty??0,'來源收貨量');
    const registered=integer(supply.incomingRegisteredQty??0,'來源在途');
    if(supplyQty>supplied||supplyReceived>received||supplyReceived>supplyQty||registered>supplyQty-supplyReceived
        ||supply.originalFulfillmentType==='DIRECT_SHIP')throw new Error('供應承諾或原供貨方式與多倉來源不一致。');
    if(cancelled&&(supply.customerCancellationDisposition!=='KEEP_STOCK'
        ||!supply.customerCancellationResolvedAt||!supply.customerCancellationResolvedBy))
        throw new Error('取消訂單尚無採購保留入庫的完整決策。');
    const demandQty=integer(demand.requestedQty,'採購需求');
    integer(demand.orderedQty,'需求供應量');integer(demand.receivedQty,'需求收貨量');
    const normalizedDemand=globalThis.YushinProcurementDemand.normalizeDemand({...demand,
        status:cancelled?'CANCELLED':'',cancelled});
    if((item.orderedQty!==undefined&&item.orderedQty!==ordered)||item.reservedQty!==held||item.shortageQty!==shortage
        ||demand.orderedQty!==supplied||demand.receivedQty!==received||demandQty<supplied
        ||demand.status!==normalizedDemand.status||demand.remainingToOrderQty!==normalizedDemand.remainingToOrderQty
        ||demand.remainingToReceiveQty!==normalizedDemand.remainingToReceiveQty
        ||(!cancelled&&demand.cancelled===true)
        ||(cancelled?(held!==0||shortage!==0||reservation.status!=='released'):held+shortage!==shipment.outstandingQty))
        throw new Error('多倉收貨數量與來源投影不一致。');
    const rows=globalThis.YushinReservation.reservationLocations(reservation);
    const candidates=new Set([warehouseId,id(item.warehouseId||order.warehouseId),...rows.map(row=>row.warehouseId)]);
    if(reservation.lifecycleWarehouseIds!==undefined){
        if(!Array.isArray(reservation.lifecycleWarehouseIds)||reservation.lifecycleWarehouseIds.length!==2
            ||new Set(reservation.lifecycleWarehouseIds).size!==2)throw new Error('原候選倉資料不正確。');
        reservation.lifecycleWarehouseIds.forEach(id);
        if([...candidates].some(w=>!reservation.lifecycleWarehouseIds.includes(w)))throw new Error('收貨倉不在原候選倉。');
        reservation.lifecycleWarehouseIds.forEach(w=>candidates.add(w));
    }
    if(candidates.size>2)throw new Error('此收貨試點最多支援兩個實體倉。');
    for(const wh of candidates){
        const master=await transaction.get(db.collection('warehouses').doc(wh));
        if(!master.exists||master.data().systemCustody||master.data().warehouseType==='CUSTODY'
            ||wh.startsWith('custody-')||(wh===warehouseId&&master.data().active===false))
            throw new Error('收貨倉或原預留倉不是可用的實體倉。');
        const stock=wh===warehouseId?warehouseStock:(await transaction.get(db.collection('warehouseStocks').doc(warehouseStockDocId(wh,productKey)))).data();
        const own=rows.find(row=>row.warehouseId===wh)?.qty||0;
        if(!stock||stock.productKey!==productKey||stock.warehouseId!==wh
            ||integer(stock.reserved,'分倉預留')<(jointHolds?.warehouses.get(wh)??own)
            ||stock.reserved+integer(stock.transferFreeInTransit??0,'分倉途中')>integer(stock.onHand,'分倉實貨'))
            throw new Error('原分倉預留或實貨帳異常，不能部分收貨。');
    }
    if(!inventory||inventory.productKey!==productKey||integer(inventory.reserved,'公司預留')<(jointHolds?.company??held)
        ||inventory.reserved+integer(inventory.transferFreeInTransit??0,'公司途中')>integer(inventory.onHand,'公司實貨'))
        throw new Error('公司多倉庫存帳異常。');
    if(supply.type==='PURCHASING_PO'){
        const po=await transaction.get(db.collection('purchaseOrders').doc(id(supply.purchaseDocumentId)));
        const record=po.exists?po.data():{},links=record.supplyOrderIds;
        // Match the actual immutable PO-line link, not a supplied array index.
        const index=Array.isArray(links)?links.indexOf(supply.id):-1;
        const line=Array.isArray(record.items)?record.items[index]:null;
        if(index<0||links.filter(key=>key===supply.id).length!==1||!line
            ||line.orderId!==orderId||line.itemId!==itemId||line.productId!==item.productId
            ||Number(line.qty)!==supply.qty||line.warehouseId!==warehouseId
            ||isPurchaseTerminalStatus(record.status))throw new Error('多倉收貨缺少有效供應商採購單憑證。');
    }else if(!['PURCHASING_MANUAL','SALES_SELF_ORDER'].includes(supply.type))throw new Error('不支援的多倉供應來源。');
    return warehouseShipmentContext;
}

async function receiveSupplyOrderRecord(supplyId,qty,lotNo='',expiryDate='',operationId='',options={}) {
    if(globalThis.YUSHIN_V2_RECEIVING_EMULATOR===true)
        return receiveV2SupplyEmulator(supplyId,qty,lotNo,expiryDate,operationId,options);
    const actorUid=options.actorUid??currentUser?.uid,actorRole=options.actorRole??currentUserRole;
    const assertActor=(supply=null)=>{
        if(!actorUid||actorUid!==currentUser?.uid||actorRole!==currentUserRole)throw new Error('登入帳號或角色已變更，請以原身分重試到貨作業。');
        if(!['admin','purchaser','warehouse','sales','engineer'].includes(actorRole)||(supply&&!canConfirmSupplyReceipt(supply)))throw new Error('目前沒有這筆到貨確認權限。');
    };
    assertActor();
    const quantity=(value,label,optional=false)=>{
        if(value===undefined&&optional)return 0;
        if((typeof value!=='number'&&typeof value!=='string')||(typeof value==='string'&&!value.trim())
            ||!Number.isFinite(Number(value))||Number(value)<0)throw new Error(`${label}數量異常，請先核對紀錄。`);
        return Number(value);
    };
    if(!Number.isFinite(qty)||qty<=0)throw new Error('到貨數量必須是大於 0 的有效數字。');
    if(typeof lotNo!=='string'||typeof expiryDate!=='string')throw new Error('到貨批號或效期格式不正確。');
    const now=new Date().toISOString(),actor=deliveryActor(),receiptDate=localDateString();
    const operationKey=String(operationId||'').trim();
    if(!operationKey)throw new Error('缺少到貨操作識別碼，請重新開啟待到貨視窗後再試。');
    let receivedProductKey='',receivedWarehouseId='',sourceOrderId='',sourceOrderStatus='',reservedForSource=0,alreadyProcessed=false,processedReceipt=null;
    const affectedOrderIds = new Set();
    const lotRef=db.collection('inventoryLots').doc(),movementRef=db.collection('inventoryMovements').doc();
    let confirmedSupply=null;
    await runRoleTransaction(async tx=>{
        assertActor();
        receivedProductKey='';receivedWarehouseId='';sourceOrderId='';sourceOrderStatus='';reservedForSource=0;alreadyProcessed=false;processedReceipt=null;confirmedSupply=null;
        affectedOrderIds.clear();
        const supplyRef=supplyOrdersCollection().doc(supplyId);
        const receiptRef=db.collection('receipts').doc(operationKey);
        const supplySnap=await tx.get(supplyRef);
        const receiptSnap=await tx.get(receiptRef);
        if(!supplySnap.exists)throw new Error('找不到供應紀錄。');
        const supply={...supplySnap.data(),id:supplyId};
        assertActor(supply);confirmedSupply=supply;
        if(!canConfirmSupplyReceipt(supply))throw new Error('原廠直送由該訂單負責業務確認；倉庫收貨僅限採購、倉管或管理員。');
        if (!globalThis.YushinSupply?.normalize || !globalThis.YushinReceiving?.buildReceiptSnapshot
            || !globalThis.YushinProcurementDemand?.applyReceipt) {
            throw new Error('Supply／Receiving／Procurement Demand core 未載入，無法建立可追溯的到貨紀錄。');
        }
        const demandRef=procurementDemandRef(supply.demandId||'');
        const demandSnap=demandRef?await tx.get(demandRef):null;
        assertActor(supply);
        const procurement=globalThis.YushinSupply.normalize({...supply,id:supplyId});
        const updateDemandReceipt=(receiptQty)=>{
            if(!demandRef)return;
            if(demandSnap?.exists){
                const demand=demandSnap.data();
                const sourceId=supply.sourceId||supply.orderId||(procurement.sourceType==='STOCK_REPLENISHMENT'?(supply.productId||supply.itemCode||''):'');
                for(const [field,expected] of [['sourceId',sourceId],['sourceItemId',supply.sourceItemId||supply.itemId||''],
                    ['productKey',supply.productKey||inventoryProductKey(supply)],['fulfillmentType',supply.fulfillmentType||'WAREHOUSE']]){
                    if(demand[field]&&demand[field]!==expected)throw new Error('採購需求與供應來源、產品或供貨方式不符。');
                }
                const ordered=quantity(demand.orderedQty,'需求已訂貨',true),received=quantity(demand.receivedQty,'需求已到貨',true);
                if(ordered-received<receiptQty)throw new Error('採購需求的未到貨承諾量不足，無法安全收貨。');
            }
            const fallbackRequested=Math.max(
                Number(supply.qty||0),
                Number(supply.receivedQty||0)+Number(receiptQty||0)
            );
            const baseDemand=demandSnap?.exists
                ? demandSnap.data()
                : globalThis.YushinProcurementDemand.normalizeDemand({
                    demandId:supply.demandId||'',
                    sourceType:supply.sourceType||(supply.orderId?'SALES_ORDER':'STOCK_REPLENISHMENT'),
                    sourceId:supply.sourceId||supply.orderId||'',
                    sourceItemId:supply.sourceItemId||supply.itemId||'',
                    requestedQty:fallbackRequested,
                    orderedQty:Math.max(fallbackRequested,Number(supply.qty||0)),
                    receivedQty:Number(supply.receivedQty||0),
                    scheduleDate:''
                });
            const receiptDemandPlan=globalThis.YushinProcurementDemand.applyReceipt(baseDemand,receiptQty);
            if(receiptDemandPlan.appliedQty!==Number(receiptQty||0)){
                throw new Error('採購需求收貨數量已變更，請重新整理後再試。');
            }
            if(demandSnap?.exists){
                const next=receiptDemandPlan.demand;
                tx.update(demandRef,{receivedQty:next.receivedQty,remainingToReceiveQty:next.remainingToReceiveQty,perReceived:next.perReceived,status:next.status,updatedAt:now});
                return;
            }
            if(['sales','engineer'].includes(currentUserRole))throw new Error('直送供應缺少採購需求紀錄，請由採購確認後再重試。');
            const demandDoc=procurementDemandDocument(receiptDemandPlan.demand,{
                sourceItemIndex:Number.isInteger(supply.orderItemIndex)?supply.orderItemIndex:baseDemand.sourceItemIndex,
                productId:supply.productId||'',
                productKey:supply.productKey||'',
                itemCode:supply.itemCode||'',
                itemName:supply.itemName||'',
                brand:supply.brand||'',
                fulfillmentType:supply.fulfillmentType||'WAREHOUSE',
                warehouseId:(supply.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP'?'':(supply.warehouseId||''),
                ownerUid:supply.ownerUid||'',
                salesCode:supply.salesCode||'',
                salesName:supply.salesName||'',
                scheduleDate:baseDemand.scheduleDate||''
            },{
                createdAt:baseDemand.createdAt||supply.createdAt||now,
                updatedAt:now
            });
            tx.set(demandRef,demandDoc,{merge:true});
        };
        const buildReceipt=(event={})=>globalThis.YushinReceiving.buildReceiptSnapshot(procurement,{
            supplyOrderId:supplyId,
            receiptDate,
            createdAt:now,
            createdBy:actor,
            ...event,
            extra:{...event.extra,createdByUid:actorUid,createdByRole:actorRole}
        });
        if (supply.orderId) affectedOrderIds.add(supply.orderId);
        // 已成功提交過的同一 receiptId 必須先走冪等重試；即使之後取消了剩餘未到貨，
        // 也不能把已完成的到貨重試誤判成新的「取消後收貨」。
        if(receiptSnap.exists){
            const receipt=receiptSnap.data()||{};
            if(receipt.reservationLocationSchemaVersion===2)await assertV2ReceiptActor(tx,actorUid,actorRole);
            if(String(receipt.supplyOrderId||'')!==String(supplyId)||Number(receipt.qty)!==qty
                ||String(receipt.lotNo||'')!==lotNo||String(receipt.expiryDate||'')!==expiryDate
                ||(receipt.createdByUid&&receipt.createdByUid!==actorUid)||(receipt.createdByRole&&receipt.createdByRole!==actorRole))throw new Error('到貨操作識別碼衝突，請重新開啟待到貨視窗。');
            alreadyProcessed=true;
            processedReceipt=receipt;
            if((receipt.fulfillmentType||supply.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP'){
                receivedProductKey=String(receipt.productKey||supply.productKey||supply.productId||'').trim();
                receivedWarehouseId=String(receipt.warehouseId||supply.warehouseId||'').trim();
                sourceOrderId=receipt.orderId||supply.orderId||'';
            }
            return;
        }
        if (isPurchaseTerminalStatus(supply.status)) {
            throw new Error(String(supply.status||'').toUpperCase()==='CLOSED'
                ? '此供應紀錄已結案，不能再確認到貨。'
                : '此供應紀錄已取消，不能再確認到貨。');
        }
        const remaining=Math.max(0,Number(supply.qty||0)-Number(supply.receivedQty||0));
        const ordered=quantity(supply.qty,'供應'),received=quantity(supply.receivedQty,'已到貨',true);
        const registeredIncoming=quantity(supply.incomingRegisteredQty,'已登記在途',true);
        if(received>ordered||registeredIncoming>ordered-received)throw new Error('供應數量或在途數量異常，請由採購核對後重試。');
        if(qty<=0||qty>remaining)throw new Error(`本次到貨數量不可超過 ${remaining}。`);
        const directShip=(supply.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP';
        if((supply.sourceType==='SALES_ORDER'||supply.itemId)&&!supply.orderId)throw new Error('供應紀錄缺少來源訂單關聯。');
        if(supply.orderId&&((supply.sourceId&&supply.sourceId!==supply.orderId)
            ||(supply.sourceItemId&&supply.sourceItemId!==supply.itemId)))throw new Error('供應紀錄的來源識別互相矛盾。');
        const validateSourceItem=(order,items)=>{
            if(orderInventorySyncIncomplete(order))throw new Error('來源訂單的庫存同步尚未完成，無法安全收貨。');
            if(!supply.itemId)throw new Error('供應紀錄缺少來源品項。');
            const matches=items.map((item,index)=>item.itemId===supply.itemId?index:-1).filter(index=>index>=0);
            if(matches.length!==1)throw new Error('來源訂單品項不存在或識別碼重複，無法安全收貨。');
            const index=matches[0],item=items[index],raw=order.items[index];
            const key=String(supply.productKey||inventoryProductKey(supply)||'').trim();
            if(!key||inventoryProductKey(item)!==key||(item.fulfillmentType||'WAREHOUSE')!==(supply.fulfillmentType||'WAREHOUSE'))
                throw new Error('供應與來源品項的產品或供貨方式不符。');
            const committed=quantity(raw.supplyOrderedQty,'來源已訂貨',true),arrived=quantity(raw.receivedQty,'來源已到貨',true);
            quantity(raw.reservedQty,'來源預留',true);
            if(committed-arrived<qty)throw new Error('來源訂單的未到貨承諾量不足，無法安全收貨。');
            return index;
        };
        if(directShip){
            if(registeredIncoming!==0)throw new Error('直送供應不可具有公司在途庫存，請由採購核對。');
            if(lotNo||expiryDate)throw new Error('原廠直送不登記公司庫存批號或效期。');
            if(!supply.orderId||!supply.itemId)throw new Error('原廠直送紀錄缺少來源訂單／品項。');
            const orderRef=db.collection('orders').doc(supply.orderId);
            const orderSnap=await tx.get(orderRef);
            if(!orderSnap.exists)throw new Error('找不到來源訂單。');
            assertActor(supply);
            const order=orderSnap.data();
            if(currentUserRole!=='admin'&&order.ownerUid!==currentUser?.uid)throw new Error('只有此訂單負責業務可確認直送到貨。');
            if(normalizedOrderStatus(order)!=='normal')throw new Error('來源訂單已取消，不能繼續確認到貨；請先處理／恢復來源訂單。');
            const items=normalizedOrderItems(order);
            const itemIndex=validateSourceItem(order,items);
            const item=items[itemIndex];
            // Purchase Receipt / Delivery are cumulative ERP events. A replacement after a return
            // can legitimately make gross delivered quantity exceed the original ordered quantity.
            // Completion is decided from net delivered (gross - returns), not by truncating history.
            const delivered=Number(item.deliveredQty||0)+qty;
            items[itemIndex]={
                ...item,
                receivedQty:Number(item.receivedQty||0)+qty,
                deliveredQty:delivered,
                directShipDeliveredQty:Number(item.directShipDeliveredQty||0)+qty,
                receiptEvents:[
                    ...(item.receiptEvents||[]),
                    {id:operationKey,at:now,date:receiptDate,qty,sourceId:supplyId,by:actor,fulfillmentType:'DIRECT_SHIP'}
                ]
            };
            const deliveryRecord={
                id:`direct-${operationKey}`,receiptId:operationKey,itemId:supply.itemId,itemIndex,date:receiptDate,qty,
                notes:'原廠直送到貨確認',createdBy:actor,createdAt:now,sourceType:'DIRECT_SHIP_RECEIPT',sourceId:supplyId
            };
            const deliveryRecords=[...savedDeliveryRecords(order),deliveryRecord];
            const grossDelivered=deliveryRecords.reduce((sum,row)=>sum+Number(row.qty||0),0);
            const returned=returnedQuantity(order);
            const total=orderQuantity({...order,items});
            const nextOrder={
                ...order,items,itemCount:items.length,orderSchemaVersion:2,
                deliveryRecords,deliveredQty:grossDelivered,
                isDelivered:Math.max(0,grossDelivered-returned)>=total&&total>0,
                updatedAt:now
            };
            tx.update(orderRef,{
                items,itemCount:items.length,orderSchemaVersion:2,
                deliveryRecords,deliveredQty:grossDelivered,isDelivered:nextOrder.isDelivered,
                ...orderWorkIndexFields(nextOrder),updatedAt:now
            });
            const receiptPlan=globalThis.YushinSupply.applyReceipt(procurement,qty);
            const receivedQty=receiptPlan.record.receivedQty;
            tx.update(supplyRef,{receivedQty,status:receiptPlan.record.status,updatedAt:now});
            updateDemandReceipt(qty);
            tx.set(receiptRef,buildReceipt({
                receiptId:operationKey,
                operationId:operationKey,
                qty,
                cumulativeReceivedQty:receivedQty,
                fulfillmentType:'DIRECT_SHIP',
                warehouseId:''
            }));
            return;
        }
        const productKey=supply.productKey||supply.productId||(supply.itemCode?`code:${normalizeHistoryItemCode(supply.itemCode)}`:'');
        if(!productKey)throw new Error('此品項缺少 產品識別碼／貨號。');
        const warehouseId=String(supply.warehouseId||'').trim();
        if(!warehouseId)throw new Error('此供應紀錄尚未指定入庫倉庫，無法安全入庫。');
        receivedProductKey=productKey;receivedWarehouseId=warehouseId;sourceOrderId=supply.orderId||'';
        const invRef=db.collection('inventory').doc(encodeURIComponent(productKey));
        const whRef=warehouseId?db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,productKey)):null;
        const invSnap=await tx.get(invRef);
        const whSnap=whRef?await tx.get(whRef):null;
        for(const [snap,label] of [[invSnap,'公司'],[whSnap,'分倉']]){
            if(!snap?.exists)continue;
            const stock=snap.data();
            if((stock.productKey&&stock.productKey!==productKey)||(stock.productId&&supply.productId&&stock.productId!==supply.productId)
                ||(label==='分倉'&&stock.warehouseId&&stock.warehouseId!==warehouseId))throw new Error('公司或分倉庫存識別不符，無法安全收貨。');
            for(const field of ['onHand','reserved','incoming'])quantity(stock[field],label+field,true);
            if(Number(stock.reserved||0)>Number(stock.onHand||0))throw new Error('公司或分倉預留超過實貨，請先核對紀錄。');
        }
        const inv=inventoryNumbers(invSnap.exists?invSnap.data():{});
        const wh=inventoryNumbers(whSnap?.exists?whSnap.data():{});
        const receiptPlan=globalThis.YushinSupply.applyReceipt(procurement,qty);
        const incomingRelease=receiptPlan.incomingReleaseQty;
        if(inv.incoming<incomingRelease||wh.incoming<incomingRelease)throw new Error('公司或分倉在途保留量不足，無法完整收貨扣回。');
        let order=null,items=[],itemIndex=-1,reserveQty=0,sourceStockPlan=null,sourceReservationV2=false;
        if(supply.orderId){
            const orderRef=db.collection('orders').doc(supply.orderId);
            const reservationRef=db.collection('inventoryReservations').doc(`${supply.orderId}__${supply.itemId}`);
            const orderSnap=await tx.get(orderRef);
            const reservationSnap=await tx.get(reservationRef);
            assertActor(supply);
            if(!orderSnap.exists)throw new Error('找不到來源訂單，無法安全收貨。');
            if(orderSnap.exists){
                order=orderSnap.data();
                sourceOrderStatus=normalizedOrderStatus(order);
                if(sourceOrderStatus!=='normal'&&supply.customerCancellationDisposition!=='KEEP_STOCK')throw new Error('請先由採購確認供應商答覆，保留採購轉庫存後再收貨。');
                // 倉庫型採購即使來源訂單已取消，供應商仍可能照常出貨。
                // 此時貨照常入庫，但不可再占回已取消訂單；整批視為自由庫存。
                items=normalizedOrderItems(order);itemIndex=validateSourceItem(order,items);
                if(itemIndex>=0){
                    let item=items[itemIndex];
                    if(!reservationSnap.exists)throw new Error('來源訂單缺少庫存預留紀錄，無法安全入庫。');
                    const savedReservation=reservationSnap.data();
                    if(savedReservation.locationSchemaVersion!==undefined||savedReservation.locations!==undefined)
                        globalThis.YushinReservation.reservationLocations(savedReservation);
                    sourceReservationV2=savedReservation.locationSchemaVersion===2;
                    if(sourceReservationV2){
                        // Preserve every untouched v2 line verbatim, not a legacy
                        // normalized projection of its quantities or metadata.
                        items=order.items.map(row=>({...row}));item=items[itemIndex];
                    }
                    const warehouseShipmentContext=sourceReservationV2?await validateV2ReceiptSource(tx,{order,supply,reservation:reservationSnap.data(),item,
                        inventory:invSnap.exists?invSnap.data():null,warehouseStock:whSnap?.exists?whSnap.data():null,
                        demand:demandSnap?.exists?demandSnap.data():null,actorUid,actorRole,qty}):undefined;
                    if(sourceOrderStatus==='normal'){
                        if(!reservationSnap.exists)throw new Error('來源訂單缺少庫存預留紀錄，無法安全入庫。');
                        const reservation=reservationSnap.data();
                        if(reservation.orderId!==supply.orderId||reservation.itemId!==supply.itemId||reservation.productKey!==productKey
                            ||(!sourceReservationV2&&(reservation.warehouseId!==warehouseId||item.warehouseId!==warehouseId))||item.transferPendingId)
                            throw new Error('來源預留的產品、倉庫或訂單關聯不符，無法安全入庫。');
                        const rawReserved=quantity(order.items[itemIndex].reservedQty,'來源預留',true);
                        const ledgerReserved=quantity(reservation.quantity,'預留帳'),ledgerShortage=quantity(reservation.shortageQty,'缺貨帳',true);
                        const localReserved=sourceReservationV2?(globalThis.YushinReservation.reservationLocations(reservation).find(row=>row.warehouseId===warehouseId)?.qty||0):ledgerReserved;
                        if(rawReserved!==ledgerReserved||Math.abs(Number(item.reservedQty||0)-ledgerReserved)>1e-9
                            ||Math.abs(Number(item.shortageQty||0)-ledgerShortage)>1e-9||inv.reserved<ledgerReserved||wh.reserved<localReserved)
                            throw new Error('來源訂單與公司／分倉預留數量不一致，請先核對紀錄。');
                        const currentReserved=Math.max(0,Number(reservation.quantity||0));
                        const receiptPlan=globalThis.YushinReceiving.applyReceiptToOrderItem({...item,reservedQty:currentReserved},qty,warehouseShipmentContext);
                        const next=receiptPlan.item;
                        sourceStockPlan=globalThis.YushinReservation.planReservationReceipt({productKey,warehouseId,qty,
                            requestedReserveQty:receiptPlan.reservedDelta,reservation,
                            aggregateStock:invSnap.exists?invSnap.data():{},warehouseStock:whSnap?.exists?whSnap.data():{},
                            itemReservedQty:order.items[itemIndex].reservedQty});
                        if(Math.abs(sourceStockPlan.allocatedQty-receiptPlan.reservedDelta)>1e-9)throw new Error('收貨預留與來源需求不一致，請先核對公司與分倉庫存。');
                        reserveQty=sourceStockPlan.allocatedQty;
                        reservedForSource=reserveQty;
                        items[itemIndex]={
                            ...next,
                            reservedQty:next.reservedQty,
                            receiptEvents:[
                                ...(item.receiptEvents||[]),
                                {id:operationKey,at:now,date:receiptDate,qty,sourceId:supplyId,by:actor,fulfillmentType:'WAREHOUSE'}
                            ]
                        };
                        const nextOrder={...order,items,itemCount:items.length,orderSchemaVersion:2,updatedAt:now};
                        tx.update(orderRef,{items,itemCount:items.length,orderSchemaVersion:2,...orderWorkIndexFields(nextOrder),updatedAt:now});
                        tx.set(reservationRef,{
                            ...sourceStockPlan.reservation,orderId:supply.orderId,itemId:supply.itemId,orderNo:order.orderNo||order.quoteNo||supply.orderId,
                            productKey,itemCode:supply.itemCode||'',itemName:supply.itemName||'',customerName:order.customerName||'',
                            ownerUid:order.ownerUid||'',salesCode:order.salesCode||'',salesName:order.salesName||'',orderDate:order.orderDate||'',
                            quantity:Number(next.reservedQty||0),shortageQty:Number(next.shortageQty||0),
                            status:Number(next.reservedQty||0)>0?'active':'shortage',...(!sourceReservationV2?{warehouseId}:{}),updatedAt:now
                        },{merge:true});
                    }else{
                        if(sourceReservationV2)sourceStockPlan=globalThis.YushinReservation.planReservationReceipt({productKey,warehouseId,qty,requestedReserveQty:0,
                            reservation:reservationSnap.data(),aggregateStock:invSnap.data(),warehouseStock:whSnap.data(),itemReservedQty:0});
                        // 取消中的來源訂單不重新占庫存，但仍同步實際到貨摘要。
                        // 這樣日後恢復訂單時，不會把已經到倉的數量再次誤判成在途採購。
                        const receiptPlan=globalThis.YushinReceiving.applyReceiptToOrderItem({...item,reservedQty:0},qty);
                        items[itemIndex]={
                            ...item,
                            receivedQty:receiptPlan.item.receivedQty,
                            receiptEvents:[
                                ...(item.receiptEvents||[]),
                                {id:operationKey,at:now,date:receiptDate,qty,sourceId:supplyId,by:actor,fulfillmentType:'WAREHOUSE',sourceOrderStatus:'cancelled'}
                            ]
                        };
                        const nextOrder={...order,items,itemCount:items.length,orderSchemaVersion:2,updatedAt:now};
                        tx.update(orderRef,{items,itemCount:items.length,orderSchemaVersion:2,...orderWorkIndexFields(nextOrder),updatedAt:now});
                    }
                }
            }
        }
        assertActor(supply);
        const embeddedLots=[...(invSnap.exists?(invSnap.data().lots||[]):[])];
        const embeddedIndex=embeddedLots.findIndex(l=>(l.lotNo||'')===lotNo&&(l.expiryDate||'')===expiryDate);
        if(embeddedIndex>=0)embeddedLots[embeddedIndex]={...embeddedLots[embeddedIndex],qty:Number(embeddedLots[embeddedIndex].qty||0)+qty};
        else embeddedLots.push({lotNo,expiryDate,qty,receivedAt:now,sourceSupplyId:supplyId});
        {
          const nextInventory={...(invSnap.exists?invSnap.data():{}),productKey,productId:supply.productId||'',itemCode:supply.itemCode||'',itemName:supply.itemName||'',brand:supply.brand||'',onHand:sourceStockPlan?sourceStockPlan.aggregateStock.onHand:inv.onHand+qty,reserved:sourceStockPlan?sourceStockPlan.aggregateStock.reserved:inv.reserved+reserveQty,incoming:inv.incoming-incomingRelease,lots:embeddedLots,updatedAt:now};
          nextInventory.searchTokens=buildInventorySearchTokens(nextInventory);
          tx.set(invRef,nextInventory,{merge:true});
        }
        if(whRef)tx.set(whRef,{warehouseId,productKey,productId:supply.productId||'',itemCode:supply.itemCode||'',itemName:supply.itemName||'',brand:supply.brand||'',onHand:sourceStockPlan?sourceStockPlan.warehouseStock.onHand:wh.onHand+qty,reserved:sourceStockPlan?sourceStockPlan.warehouseStock.reserved:wh.reserved+reserveQty,incoming:wh.incoming-incomingRelease,updatedAt:now},{merge:true});
        tx.set(lotRef,{productKey,productId:supply.productId||'',warehouseId,lotNo,expiryDate,receivedQty:qty,remainingQty:qty,supplier:supply.supplier||'',sourceType:'SUPPLY_ORDER',sourceId:supplyId,receivedAt:now});
        tx.set(db.collection('inventoryLotCosts').doc(lotRef.id),{lotId:lotRef.id,productKey,productId:supply.productId||'',warehouseId,...(currentUserRole==='warehouse'&&permissionRulesReady?{costSourceSupplyId:supplyId}:{unitCost:Number(supply.unitCost||0)}),sourceType:'SUPPLY_ORDER',sourceId:supplyId,createdAt:now,createdBy:actor});
        const autoAllocationQty=Math.max(0,Number(qty||0)-reserveQty);
        tx.set(receiptRef,buildReceipt({
            receiptId:operationKey,
            operationId:operationKey,
            qty,
            cumulativeReceivedQty:receiptPlan.record.receivedQty,
            productKey,
            warehouseId,
            fulfillmentType:'WAREHOUSE',
            extra:{
                sourceOrderStatus,
                ...(sourceReservationV2?{reservationLocationSchemaVersion:2}:{}),
                autoAllocationQty,
                autoAllocatedQty:0,
                allocationCompleted:autoAllocationQty===0,
                lotId:lotRef.id,
                lotNo,
                expiryDate
            }
        }));
        tx.set(movementRef,{type:'receipt',qty,productKey,warehouseId,lotNo,expiryDate,sourceType:'SUPPLY_ORDER',sourceId:supplyId,receiptId:operationKey,createdAt:now,createdBy:actor,ownerUid:supply.ownerUid||'',salesCode:supply.salesCode||''});
        updateDemandReceipt(qty);
        tx.update(supplyRef,{
            receivedQty:receiptPlan.record.receivedQty,
            incomingRegisteredQty:receiptPlan.record.incomingRegisteredQty,
            status:receiptPlan.record.status,
            updatedAt:now
        });
    });
    try {
        assertActor(confirmedSupply);
        if (receivedProductKey && receivedWarehouseId) options.onStockCommitted?.(receivedProductKey, receivedWarehouseId);

        // Replenishment / excess receipt stock automatically serves oldest outstanding shortages.
        // The physical receipt is already committed before this phase. If this follow-up is interrupted,
        // the same immutable receiptId is reused to count prior allocations and only the remainder is retried.
        let freeQty=receivedProductKey&&receivedWarehouseId?Math.max(0,Number(qty||0)-reservedForSource):0;
        if(alreadyProcessed){
            const allocationTarget=Math.max(0,Number(processedReceipt?.autoAllocationQty||0));
            if(allocationTarget>0){
                const priorMovements=await readQueryInBatches(
                    db.collection('inventoryMovements').where('receiptId','==',operationKey)
                );
                assertActor(confirmedSupply);
                const alreadyAllocated=priorMovements
                    .filter(row=>row.type==='reserve_from_receipt')
                    .reduce((sum,row)=>sum+Math.max(0,Number(row.qty||0)),0);
                let reconciledAllocated=alreadyAllocated;
                await runRoleTransaction(async tx=>{
                    assertActor(confirmedSupply);
                    const receiptRef=db.collection('receipts').doc(operationKey);
                    const receiptSnap=await tx.get(receiptRef);
                    assertActor(confirmedSupply);
                    if(!receiptSnap.exists)throw new Error('找不到已提交的到貨分配進度。');
                    const receipt=receiptSnap.data()||{};
                    const currentAllocated=Math.max(0,Number(receipt.autoAllocatedQty||0));
                    reconciledAllocated=Math.max(currentAllocated,alreadyAllocated);
                    if(reconciledAllocated!==currentAllocated){
                        tx.update(receiptRef,{
                            autoAllocatedQty:reconciledAllocated,
                            allocationCompleted:reconciledAllocated>=allocationTarget,
                            allocationUpdatedAt:new Date().toISOString()
                        });
                    }
                });
                assertActor(confirmedSupply);
                freeQty=Math.max(0,allocationTarget-reconciledAllocated);
            }else{
                freeQty=0;
            }
        }
        if(freeQty>0){
            const allocation=await allocateFreeReceiptStockToShortages(
                receivedProductKey,receivedWarehouseId,freeQty,actor,sourceOrderId,operationKey,'receipts',()=>assertActor(confirmedSupply),options.onStockCommitted
            );
            allocation.affectedOrderIds.forEach(id=>affectedOrderIds.add(id));
        }
        assertActor(confirmedSupply);
        return [...affectedOrderIds];
    }catch(allocationErr){
        const error=new Error(
            '到貨已提交，但後續確認或庫存分配尚未完成：'
            +(allocationErr?.message||allocationErr)
            +'。請再按一次「確認到貨」重試；系統不會重複入庫。'
        );
        error.code='receipt-allocation-pending';
        error.receiptCommitted=true;
        error.affectedOrderIds=[...affectedOrderIds];
        throw error;
    }
}

