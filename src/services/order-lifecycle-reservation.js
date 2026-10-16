async function adjustInventoryReservationForLifecycle(transaction, orderId, order, nextStatus, actor, options={}) {
    if(!['normal','cancelled'].includes(nextStatus))throw new Error('不支援的訂單狀態。');
    if(!Array.isArray(order?.items)||!order.items.length
        ||order.items.some(item=>!item||typeof item!=='object'||Array.isArray(item)))
        throw new Error('訂單缺少有效品項明細，無法安全取消或恢復。請由管理員核對原始訂單、庫存預留及採購需求。');
    const items = normalizedOrderItems(order);
    // Multiple lines must never address the same reservation or demand document,
    // including collisions between generated legacy IDs and explicit IDs.
    const itemIds=items.map((item,index)=>String(item.itemId||`item-${index+1}`));
    if(new Set(itemIds).size!==itemIds.length)
        throw new Error('訂單品項識別碼重複，無法安全取消或恢復。請由管理員核對品項與庫存預留。');
    const now = new Date().toISOString();

    // Firestore transactions require every read before the first write.
    const contexts = [];
    // A restored order may only reserve against a live physical warehouse.
    // Reuse master snapshots when several items target the same location.
    const restoredWarehouseSnapshots = new Map();
    // All linked purchase demands must be read before the first transaction write.
    // Deletion/testing flows may opt out explicitly; regular lifecycle never does.
    const syncLinkedDemands=!options.skipDemandSync;
    for (let index = 0; index < items.length; index++) {
        const item = items[index];
        const savedItem=order.items?.[index]||{};
        const itemReservedQty=Object.hasOwn(savedItem,'reservedQty')?savedItem.reservedQty:item.reservedQty;
        const itemId = String(item.itemId || `item-${index + 1}`);
        const productKey = inventoryProductKey(item);
        const directShip = (item.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP';
        // Reuse the canonical projection: closed returns do not need replacement,
        // and legacy item-only delivery totals remain authoritative when no ledger exists.
        const delivered = Math.max(0, Number(item.deliveredQty||0)-Number(item.returnedQty||0));
        const ordered = Math.max(0, Number(item.qty || item.orderedQty || 0));
        const warehouseId = directShip ? '' : (item.warehouseId || order.warehouseId || defaultWarehouse()?.id || '');
        const invRef = !directShip && productKey ? inventoryRefFor(item) : null;
        const whRef = !directShip && warehouseId && productKey ? db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId, productKey)) : null;
        const reservationRef = db.collection('inventoryReservations').doc(`${orderId}__${itemId}`);
        const invSnap = invRef ? await transaction.get(invRef) : null;
        const whSnap = whRef ? await transaction.get(whRef) : null;
        const reservationSnap = await transaction.get(reservationRef);
        const demandRef=syncLinkedDemands?procurementDemandRef(globalThis.YushinProcurementDemand.demandIdForSource({sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId})):null;
        const demandSnap=demandRef?await transaction.get(demandRef):null;
        const reservationData=reservationSnap.exists?reservationSnap.data():{};
        // Cancellation/restoration still writes one location. Reject future v2 records.
        globalThis.YushinReservation.assertLegacyReservationLocation(reservationData);
        if(nextStatus==='normal'&&!directShip&&productKey){
            if(!warehouseId||String(warehouseId).startsWith('custody-'))
                throw new Error('原訂單倉庫不是可用的實體倉庫；請由管理員先核對倉庫與貨品位置，再恢復訂單。');
            let warehouseSnap=restoredWarehouseSnapshots.get(warehouseId);
            if(!warehouseSnap){
                warehouseSnap=await transaction.get(db.collection('warehouses').doc(warehouseId));
                restoredWarehouseSnapshots.set(warehouseId,warehouseSnap);
            }
            if(!warehouseSnap.exists||warehouseSnap.data().active===false
                ||warehouseSnap.data().systemCustody||warehouseSnap.data().warehouseType==='CUSTODY')
                throw new Error('原訂單倉庫已停用、已刪除或屬業務保管位置，不能恢復預留。請由管理員核對倉庫及調撥紀錄。');
        }
        if(!directShip&&item.transferPendingId)throw new Error('此品項尚在倉庫調撥途中，請目的倉確認收貨後再取消或恢復。');
        for(const [key,value] of Object.entries({orderId,itemId,productKey,warehouseId})){
            if(reservationData[key]!==undefined&&reservationData[key]!==value)
                throw new Error('預留來源、產品或倉庫與訂單不一致，請先核對資料。');
        }
        for(const snap of [invSnap,whSnap]){
            if(snap?.exists&&snap.data().productKey!==undefined&&snap.data().productKey!==productKey)
                throw new Error('庫存產品與訂單不一致，請先核對資料。');
        }
        if(whSnap?.exists&&whSnap.data().warehouseId!==undefined&&whSnap.data().warehouseId!==warehouseId)
            throw new Error('分倉庫存位置與訂單不一致，請先核對資料。');
        contexts.push({item,itemReservedQty,itemId,index,productKey,directShip,delivered,ordered,warehouseId,invRef,whRef,invSnap,whSnap,reservationRef,reservationSnap,reservationData,demandRef,demandSnap});
    }

    const nextItems = [];
    let totalReserved = 0;
    let totalShortage = 0;
    const stockStates = new Map();
    contexts.forEach(ctx => {
        if (ctx.invRef && ctx.invSnap?.exists && !stockStates.has(ctx.invRef.path)) stockStates.set(ctx.invRef.path,{...ctx.invSnap.data(),ref:ctx.invRef,beforeReserved:ctx.invSnap.data().reserved});
        if (ctx.whRef && ctx.whSnap?.exists && !stockStates.has(ctx.whRef.path)) stockStates.set(ctx.whRef.path,{...ctx.whSnap.data(),ref:ctx.whRef,beforeReserved:ctx.whSnap.data().reserved});
    });

    for (const ctx of contexts) {
        const {item,itemReservedQty,itemId,productKey,directShip,delivered,ordered,warehouseId,invRef,whRef,invSnap,whSnap,reservationRef,reservationSnap,reservationData} = ctx;

        if (directShip || !productKey) {
            // A direct or unlinked line cannot silently erase an existing hold.
            globalThis.YushinReservation.planReservationLifecycle({nextStatus:'cancelled',
                existingQty:reservationData.quantity,itemReservedQty});
            const shortage = directShip ? 0 : Math.max(0, ordered - delivered);
            transaction.set(reservationRef, {
                orderId,itemId,orderNo:order.orderNo||order.quoteNo||orderId,productKey,
                itemCode:item.itemCode||'',itemName:item.itemName||'',customerName:order.customerName||'',
                salesCode:order.salesCode||salesCodeForName(order.salesName),salesName:order.salesName||'',
                orderDate:order.orderDate||'',quantity:0,shortageQty:nextStatus==='cancelled'?0:shortage,
                status:nextStatus==='cancelled'?'released':(directShip?'direct_ship':'shortage'),warehouseId:'',updatedAt:now
            }, { merge:true });
            const nextReserved = nextStatus==='cancelled' ? 0 : 0;
            nextItems.push({...item,itemId,reservedQty:nextReserved,shortageQty:nextStatus==='cancelled'?0:shortage});
            totalReserved += nextReserved;
            totalShortage += nextStatus==='cancelled'?0:shortage;
            continue;
        }

        const invState = invRef ? stockStates.get(invRef.path) : null;
        const whState = whRef ? stockStates.get(whRef.path) : null;
        const existingQty=reservationData.quantity;
        if(Number(existingQty)>0&&(!reservationSnap.exists||reservationData.warehouseId!==warehouseId))
            throw new Error('既有預留缺少正確位置，請先核對資料。');
        if (nextStatus === 'cancelled') {
            const plan=globalThis.YushinReservation.planReservationLifecycle({nextStatus,existingQty,
                itemReservedQty,aggregateStock:invState,warehouseStock:whState});
            const release=-plan.reservedDelta;
            if (release > 0) {
                invState.reserved = Number(invState.reserved||0) - release;
                whState.reserved = Number(whState.reserved||0) - release;
                transaction.set(db.collection('inventoryMovements').doc(), inventoryMovementRecord('release',-release,orderId,productKey,actor,{reason:'order_cancelled',warehouseId,itemId}));
            }
            transaction.set(reservationRef,{
                orderId,itemId,orderNo:order.orderNo||order.quoteNo||orderId,productKey,
                itemCode:item.itemCode||'',itemName:item.itemName||'',customerName:order.customerName||'',
                salesCode:order.salesCode||salesCodeForName(order.salesName),salesName:order.salesName||'',
                orderDate:order.orderDate||'',quantity:0,shortageQty:0,status:'released',warehouseId,updatedAt:now
            },{merge:true});
            nextItems.push({...item,itemId,reservedQty:0,shortageQty:0});
            continue;
        }

        const outstanding = Math.max(0, ordered - delivered);
        // 已下 PO／自行訂購的數量屬於既有在途供應，恢復訂單時不能再拿同一數量預留現貨，
        // 否則會同時出現「待到貨」與庫存 reservation，造成供應量重複計算。
        const orderedSupply = Math.max(0, Number(item.supplyOrderedQty||0));
        const receivedSupply = Math.max(0, Number(item.receivedQty||0));
        const incomingSupply = Math.min(outstanding, Math.max(0, orderedSupply - receivedSupply));
        const plan=globalThis.YushinReservation.planReservationLifecycle({nextStatus,existingQty,
            itemReservedQty,requestedQty:outstanding,inTransitQty:incomingSupply,
            aggregateStock:invState,warehouseStock:whState});
        const reserve=plan.reservedQty;
        // shortageQty 一律代表尚無實貨預留的量；已下訂待到貨另由 supplyOrderedQty - receivedQty 涵蓋。
        const shortage = Math.max(0, outstanding - reserve);
        if(plan.reservedDelta){
            invState.reserved=Number(invState.reserved||0)+plan.reservedDelta;
            whState.reserved=Number(whState.reserved||0)+plan.reservedDelta;
            transaction.set(db.collection('inventoryMovements').doc(),inventoryMovementRecord(plan.reservedDelta>0?'reserve':'release',plan.reservedDelta,orderId,productKey,actor,{reason:'order_restored',warehouseId,itemId}));
        }
        transaction.set(reservationRef,{
            orderId,itemId,orderNo:order.orderNo||order.quoteNo||orderId,productKey,
            itemCode:item.itemCode||'',itemName:item.itemName||'',customerName:order.customerName||'',
            salesCode:order.salesCode||salesCodeForName(order.salesName),salesName:order.salesName||'',
            orderDate:order.orderDate||'',quantity:reserve,shortageQty:shortage,
            status:reserve>0?'active':(shortage>0?'shortage':'fulfilled'),warehouseId,updatedAt:now
        },{merge:true});
        nextItems.push({...item,itemId,reservedQty:reserve,shortageQty:shortage});
        totalReserved += reserve;
        totalShortage += shortage;
    }

    // Restore/cancel the linked demand in the same transaction as reservations
    // and stock; never publish an order status before its procurement projection.
    if(syncLinkedDemands){
        const restoredOrder=nextStatus==='normal'
            ? {...order,id:orderId,status:'active',orderStatus:'normal',items:nextItems}
            : null;
        for(const ctx of contexts){
            const previous=ctx.demandSnap?.exists?ctx.demandSnap.data():null;
            if(previous&&(
                previous.demandId!=='SALES_ORDER:'+orderId+':'+ctx.itemId
                ||previous.sourceType!=='SALES_ORDER'||previous.sourceId!==orderId
                ||previous.sourceItemId!==ctx.itemId||previous.productKey!==ctx.productKey
                ||previous.ownerUid!==order.ownerUid||previous.salesCode!==order.salesCode
                ||(previous.sourceItemIndex!==undefined&&previous.sourceItemIndex!==-1&&previous.sourceItemIndex!==ctx.index)
            ))throw new Error('採購需求與訂單歸屬或品項不一致，請先核對資料。');
            if(nextStatus==='cancelled'){
                if(previous&&previous.status!=='CANCELLED')
                    transaction.update(ctx.demandRef,{status:'CANCELLED',remainingToOrderQty:0,
                        sourceItemIndex:ctx.index,updatedAt:now});
                continue;
            }
            const nextItem=nextItems[ctx.index];
            const doc=orderItemProcurementDemandDocument(restoredOrder,nextItem,previous,now);
            if(previous){
                // Historical supplier orders and receipts cannot be erased,
                // inferred upwards, or reassigned by restoring a commercial order.
                if(previous.orderedQty!==doc.orderedQty||previous.receivedQty!==doc.receivedQty
                    ||previous.fulfillmentType!==doc.fulfillmentType
                    ||previous.warehouseId!==doc.warehouseId)
                    throw new Error('採購需求與供應商履約紀錄不一致，請先稽核再恢復訂單。');
                transaction.update(ctx.demandRef,{
                    requestedQty:doc.requestedQty,remainingToOrderQty:doc.remainingToOrderQty,
                    remainingToReceiveQty:doc.remainingToReceiveQty,perOrdered:doc.perOrdered,
                    perReceived:doc.perReceived,status:doc.status,sourceItemIndex:ctx.index,
                    updatedAt:now
                });
            }else if(doc.requestedQty>0||doc.orderedQty>0||doc.receivedQty>0){
                transaction.set(ctx.demandRef,doc);
            }
        }
    }
    stockStates.forEach(state => {
        if(Number(state.reserved||0)!==Number(state.beforeReserved||0))
            transaction.update(state.ref,{reserved:Number(state.reserved||0),updatedAt:now});
    });
    transaction.update(db.collection('orders').doc(orderId),{
        items:nextItems,updatedAt:now
    });
    return {items:nextItems,totalReserved,totalShortage};
}

