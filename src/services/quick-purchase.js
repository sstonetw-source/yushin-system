// Emulator-only adapter. Normal GitHub-served production never enables this pilot.
function quickPurchaseBackendPilotEnabled() {
    return typeof APP_ENVIRONMENT !== 'undefined' && APP_ENVIRONMENT === 'emulator'
        && globalThis.YUSHIN_QUICK_PURCHASE_EMULATOR === true;
}
async function commitQuickPurchaseBackendPilot(orderId,itemId,details,actorUid,assertActor) {
    const local=host=>['localhost','127.0.0.1'].includes(host);
    const host=String(globalThis.location?.hostname||'').toLowerCase();
    if(!quickPurchaseBackendPilotEnabled() || !local(host)
        || typeof firebase==='undefined' || !firebase.auth || !firebase.app
        || firebase.app().options?.projectId!=='demo-yushin'
        || firebase.auth().app?.options?.projectId!=='demo-yushin'
        || !local(firebase.auth().emulatorConfig?.host)
        || firebase.auth().emulatorConfig?.port!==9099)
        throw new Error('手動採購後端試點僅限隔離的 demo Emulator，未提交採購。');
    if(!Number.isSafeInteger(details.expectedQty) || details.expectedQty<=0 || details.expectedQty>1000000)
        throw new Error('手動採購數量不正確，未提交採購。');
    const qty=details.expectedQty, supplier=details.supplier,unitCost=details.unitCost;
    const key='quick-purchase-pending:'+encodeURIComponent(actorUid)+':'
        +encodeURIComponent(orderId)+':'+encodeURIComponent(itemId);
    const fingerprint=JSON.stringify([actorUid,orderId,itemId,qty,supplier,unitCost]);
    let pending;
    try {
        const raw=sessionStorage.getItem(key);
        if(raw)pending=JSON.parse(raw);
    } catch (_) {
        throw new Error('前次採購憑證無法讀取，請先核對採購結果，勿另建採購。');
    }
    if(pending && (pending.version!==1||pending.fingerprint!==fingerprint
        ||typeof pending.operationId!=='string'||!/^qp-[A-Za-z0-9_-]{8,76}$/.test(pending.operationId)))
        throw new Error('前次手動採購尚待核對，請使用原操作及內容確認，勿另建採購。');
    const operationId=pending?.operationId||('qp-'+db.collection('purchaseOperations').doc().id);
    if(!pending) {
        try {sessionStorage.setItem(key,JSON.stringify({version:1,fingerprint,operationId}));}
        catch (_) {throw new Error('無法保存採購重試憑證，未提交採購。');}
    }
    await ensureFormalPurchaseFunctionsCompat();
    const functions=firebase.app().functions('asia-east1');
    if(functions.app?.options?.projectId!=='demo-yushin')
        throw new Error('手動採購後端連線專案不正確，未提交採購。');
    functions.useEmulator('127.0.0.1',5001);
    const check=()=>{assertActor();
        if(firebase.auth().currentUser?.uid!==actorUid)
            throw new Error('登入身分已變更，請以原帳號核對採購結果。');};
    check();
    const response=await functions.httpsCallable('commitV2QuickPurchase')({
        operationId,orderId,itemId,qty,supplier,unitCost
    });
    check();
    const result=response?.data;
    const supplyId=quickPurchaseSupplyId(orderId,itemId);
    const demandId=globalThis.YushinProcurementDemand.demandIdForSource({
        sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId
    });
    if(!['committed','already-applied'].includes(result?.status)
        ||result.operationId!==operationId||result.supplyId!==supplyId
        ||result.demandId!==demandId||result.committedQty!==qty)
        throw new Error('採購回覆不明確，請以原操作核對，勿另建採購。');
    // A missing response or failed read preserves the checkpoint, never
    // silently retries through the legacy client multi-document transaction.
    const read=async(name,id)=>{
        const snapshot=await db.collection(name).doc(id).get({source:'server'});
        check();
        if(!snapshot.exists)throw new Error('採購可能已提交但回讀資料不完整，請確認原操作。');
        return {id,...snapshot.data()};
    };
    const [savedOrder,savedSupply,savedDemand]=await Promise.all([
        read('orders',orderId),read('supplyOrders',supplyId),
        read('procurementDemands',encodeURIComponent(demandId))
    ]);
    const sourceItem=savedOrder.items?.find(row=>row.itemId===itemId);
    if(savedSupply.demandId!==demandId || savedDemand.demandId!==demandId
        ||!savedSupply.orderEvents?.some(row=>row.operationId===operationId
            &&row.createdByUid===actorUid&&row.qty===qty
            &&row.supplier===supplier&&row.unitCost===unitCost)
        ||!sourceItem?.orderEvents?.some(row=>row.id==='quick-'+operationId))
        throw new Error('採購權威憑證不一致，請確認原操作，勿另建採購。');
    check();
    try {sessionStorage.removeItem(key);}
    catch (_) {throw new Error('採購已確認但重試憑證未能清除，請先核對原操作。');}
    return {savedOrder,savedSupply,savedDemand,
        incomingProductKey:savedSupply.fulfillmentType==='DIRECT_SHIP'?'':savedSupply.productKey,
        incomingWarehouseId:savedSupply.fulfillmentType==='DIRECT_SHIP'?'':savedSupply.warehouseId};
}

// Atomic quick-purchase commitment; UI refresh belongs to the caller.
async function commitQuickPurchase(orderId, itemId, purchaseDetails, actorUid=currentUser?.uid, actorRole=currentUserRole) {
        if (!purchaseDetails || typeof purchaseDetails.supplier !== 'string' || !purchaseDetails.supplier.trim()
            || !Number.isFinite(purchaseDetails.unitCost) || purchaseDetails.unitCost < 0
            || !Number.isFinite(purchaseDetails.expectedQty) || purchaseDetails.expectedQty < 0)
            throw new Error('請確認供應商、數量與有效的實際單位成本。');
        purchaseDetails={...purchaseDetails,supplier:purchaseDetails.supplier.trim()};
        const assertActor=()=>{
            if (!actorUid || currentUser?.uid!==actorUid || currentUserRole!==actorRole)
                throw new Error('登入身份已變更，請以原帳號重新確認採購。');
            if (!canCreatePurchaseOrderCapability() || !canAccessPage('orders.po')) throw new Error('目前無採購作業權限。');
        };
        assertActor();
        if(globalThis.YUSHIN_QUICK_PURCHASE_EMULATOR===true) {
            if(!quickPurchaseBackendPilotEnabled())
                throw new Error('手動採購後端試點與目前環境不一致，禁止改用舊交易。');
            return commitQuickPurchaseBackendPilot(orderId,itemId,purchaseDetails,actorUid,assertActor);
        }
        const actorName=currentUserName||currentUser?.email||'', now=new Date().toISOString(), orderDate=localDateString();
        let savedOrder, savedSupply, savedDemand, incomingProductKey='', incomingWarehouseId='';
        const supplyRef = supplyOrdersCollection().doc(quickPurchaseSupplyId(orderId, itemId));
        await runRoleTransaction(async tx => {
            assertActor();
            savedOrder=savedSupply=savedDemand=undefined;
            incomingProductKey=incomingWarehouseId='';
            const orderRef = db.collection('orders').doc(orderId);
            const [orderSnapshot, supplySnapshot] = await Promise.all([tx.get(orderRef), tx.get(supplyRef)]);
            assertActor();
            if (!orderSnapshot.exists) throw new Error('來源訂單已不存在。');
            const order = { id:orderId, ...orderSnapshot.data() };
            if (normalizedOrderStatus(order) !== 'normal') throw new Error('來源訂單已取消或作廢。');
            const items = normalizedOrderItems(order);
            const itemIndex = items.findIndex(item => item.itemId === itemId);
            if (itemIndex < 0) throw new Error('找不到來源訂單品項。');
            const item = items[itemIndex];
            const demand = procurementDemandForOrderItem(order, item);
            const qty = demand.remainingToOrderQty;
            if (qty > 0 && qty !== purchaseDetails.expectedQty) throw new Error('待採購數量已變更，請重新開啟確認。');
            if ((item.procurementType || order.procurementType || 'PURCHASING_PO') === 'SALES_SELF_ORDER') throw new Error('此品項為業務自行訂貨。');
            const demandId = demand.demandId || '';
            const existingSupply = supplySnapshot.exists ? { id:supplyRef.id, ...supplySnapshot.data() } : null;
            if (!(qty > 0) && !existingSupply) throw new Error('此品項已無待採購數量，請重新整理。');

            const currentProductKey = poIncomingKey(item);
            const currentFulfillmentType = item.fulfillmentType || order.fulfillmentType || 'WAREHOUSE';
            const currentWarehouseId = currentFulfillmentType === 'DIRECT_SHIP'
                ? '' : (item.warehouseId || defaultWarehouse()?.id || '');
            const productKey = existingSupply?.productKey || currentProductKey;
            const fulfillmentType = existingSupply?.fulfillmentType || currentFulfillmentType;
            const directShip = fulfillmentType === 'DIRECT_SHIP';
            const warehouseId = directShip ? '' : (existingSupply?.warehouseId || currentWarehouseId);

            if (existingSupply) {
                if (qty > 0 && (existingSupply.supplier !== purchaseDetails.supplier || Number(existingSupply.unitCost) !== purchaseDetails.unitCost)) {
                    throw new Error('追加採購的供應商或單價不同，請使用「產生採購單」另建紀錄，保留原採購金額。');
                }
                if (existingSupply.productKey && currentProductKey && existingSupply.productKey !== currentProductKey) {
                    throw new Error('此品項已建立供應紀錄，產品識別不可在追加採購前變更。');
                }
                if ((existingSupply.fulfillmentType || 'WAREHOUSE') !== currentFulfillmentType) {
                    throw new Error('此品項已建立供應紀錄，交付方式不可在追加採購前變更。');
                }
                if (!directShip && existingSupply.warehouseId && currentWarehouseId && existingSupply.warehouseId !== currentWarehouseId) {
                    throw new Error('此品項已建立供應紀錄，入庫倉庫不可在追加採購前變更。');
                }
            }
            if (!directShip && (!productKey || !warehouseId)) throw new Error('訂單快照缺少貨號或入庫倉庫，請先修正來源訂單。');

            const internalNo = existingSupply?.internalNo || `MO-${orderDate.replace(/-/g, '')}-${supplyRef.id.slice(-8).toUpperCase()}`;
            const alreadyOrdered = Math.max(0, Number(item.supplyOrderedQty || 0));
            const identity = brandIdentityForRecord(existingSupply || item);
            const canonicalBrand = identity.brand || resolveBrandName(existingSupply?.brand || item.brand || '');
            const canonicalBrandId = identity.brandId || existingSupply?.brandId || item.brandId || brandIdForName(canonicalBrand);
            const productId = String(existingSupply?.productId || item.productId || '').trim();
            const demandOrderPlan=globalThis.YushinProcurementDemand.applyOrder(demand,qty);
            if(qty>0&&demandOrderPlan.appliedQty!==qty)throw new Error('採購需求數量已變更，請重新整理後再試。');
            const demandRef=procurementDemandRef(demandId);
            const demandDoc=procurementDemandDocument(demandOrderPlan.demand,{
                productId,
                productKey,
                itemCode:item.itemCode||'',
                itemName:item.itemName||'',
                brand:canonicalBrand,
                brandId:canonicalBrandId,
                fulfillmentType,
                warehouseId,
                ownerUid:order.ownerUid||'',
                salesCode:order.salesCode||'',
                salesName:order.salesName||'',
                scheduleDate:item.scheduleDate||order.expectedDate||''
            },{
                createdAt:order.createdAt||now,
                updatedAt:now
            });
            const previousSupplyQty = Math.max(0, Number(existingSupply?.qty || 0));
            const nextSupplyQty = previousSupplyQty + Math.max(0, Number(qty || 0));
            const nextOrdered = alreadyOrdered + Math.max(0, Number(qty || 0));
            if (!globalThis.YushinReceiving?.normalizeSupply) {
                throw new Error('Receiving core 未載入，無法計算待到貨狀態。');
            }
            const supplyProjection = globalThis.YushinReceiving.normalizeSupply({
                ...(existingSupply || {}),
                qty: nextSupplyQty
            });
            const receivedQty = supplyProjection.receivedQty;
            const nextSupplyStatus = supplyProjection.status;
            const registeredIncomingQty = Math.max(0, Number(existingSupply?.incomingRegisteredQty || 0));
            const targetIncomingQty = directShip ? 0 : supplyProjection.remainingQty;
            const incomingDelta = targetIncomingQty - registeredIncomingQty;

            let invRef=null, whRef=null, invSnap=null, whSnap=null;
            if (!directShip && incomingDelta !== 0) {
                invRef = db.collection('inventory').doc(encodeURIComponent(productKey));
                whRef = db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId, productKey));
                [invSnap, whSnap] = await Promise.all([tx.get(invRef), tx.get(whRef)]);
            }
            assertActor();

            // 單純重試時不增加訂購量或事件，但仍會修復曾中斷的 incoming 同步。
            const orderEvents = Array.isArray(existingSupply?.orderEvents) ? existingSupply.orderEvents.slice() : [];
            if (qty > 0) {
                orderEvents.push({ qty, supplier:purchaseDetails.supplier, unitCost:purchaseDetails.unitCost, orderDate, createdAt:now, createdByUid:actorUid, createdBy:actorName });
            }

            savedSupply = {
                ...(existingSupply || {}),
                id:supplyRef.id,
                type:'PURCHASING_MANUAL',
                method:'PURCHASING_MANUAL',
                sourceType:'SALES_ORDER',
                sourceId:orderId,
                sourceItemId:itemId,
                demandId:existingSupply?.demandId||demandId||'',
                internalNo,
                status:nextSupplyStatus,
                orderId:existingSupply?.orderId||orderId,
                itemId:existingSupply?.itemId||itemId,
                orderItemIndex:existingSupply?.orderItemIndex??itemIndex,
                ownerUid:existingSupply?.ownerUid||order.ownerUid||'',
                salesCode:existingSupply?.salesCode||order.salesCode||'',
                salesName:existingSupply?.salesName||order.salesName||'',
                customerName:existingSupply?.customerName||order.customerName||'',
                company:existingSupply?.company||order.company||'yushin',
                productId,
                productKey,
                itemCode:existingSupply?.itemCode||item.itemCode||'',
                itemName:existingSupply?.itemName||item.itemName||'',
                brand:canonicalBrand,
                brandId:canonicalBrandId,
                productLine:existingSupply?.productLine||item.productLine||'',
                qty:nextSupplyQty,
                receivedQty,
                incomingRegisteredQty:targetIncomingQty,
                incomingRegisteredAt:incomingDelta !== 0 ? now : (existingSupply?.incomingRegisteredAt||''),
                supplier:existingSupply?.supplier || purchaseDetails.supplier,
                unitCost:existingSupply?.unitCost ?? purchaseDetails.unitCost,
                orderDate:existingSupply?.orderDate||orderDate,
                lastOrderedAt:qty > 0 ? orderDate : (existingSupply?.lastOrderedAt||existingSupply?.orderDate||orderDate),
                orderEvents,
                fulfillmentType,
                warehouseId,
                createdAt:existingSupply?.createdAt||now,
                updatedAt:now,
                createdByUid:existingSupply?.createdByUid||actorUid,
                createdBy:existingSupply?.createdBy||actorName,
                createdByRole:existingSupply?.createdByRole||actorRole
            };

            if (invRef && whRef) {
                const inv = inventoryNumbers(invSnap?.exists ? invSnap.data() : {});
                const wh = inventoryNumbers(whSnap?.exists ? whSnap.data() : {});
                if (invSnap?.exists) {
                    tx.set(invRef, {
                        productId,
                        itemCode:existingSupply?.itemCode||item.itemCode||'',
                        itemName:existingSupply?.itemName||item.itemName||'',
                        brand:canonicalBrand,
                        brandId:canonicalBrandId,
                        incoming:Math.max(0,inv.incoming+incomingDelta),
                        updatedAt:now
                    }, {merge:true});
                } else {
                    const nextInventory = {
                        productKey,
                        productId,
                        itemCode:existingSupply?.itemCode||item.itemCode||'',
                        itemName:existingSupply?.itemName||item.itemName||'',
                        brand:canonicalBrand,
                        brandId:canonicalBrandId,
                        onHand:0, reserved:0,
                        incoming:Math.max(0,incomingDelta), lots:[], updatedAt:now
                    };
                    nextInventory.searchTokens=buildInventorySearchTokens(nextInventory);
                    tx.set(invRef,nextInventory,{merge:true});
                }
                tx.set(whRef,{
                    warehouseId,productKey,
                    productId,
                    itemCode:existingSupply?.itemCode||item.itemCode||'',
                    itemName:existingSupply?.itemName||item.itemName||'',
                    brand:canonicalBrand,
                    brandId:canonicalBrandId,
                    onHand:wh.onHand,reserved:wh.reserved,
                    incoming:Math.max(0,wh.incoming+incomingDelta),updatedAt:now
                },{merge:true});
                tx.set(db.collection('inventoryMovements').doc(),{
                    type:'purchase_incoming',qty:incomingDelta,productKey,productId,warehouseId,
                    brand:canonicalBrand,brandId:canonicalBrandId,
                    fulfillmentType:'WAREHOUSE',sourceType:'SUPPLY_ORDER',sourceId:supplyRef.id,
                    purchaseDocumentId:internalNo,createdAt:now,
                    createdBy:actorName,
                    ownerUid:existingSupply?.ownerUid||order.ownerUid||'',
                    salesCode:existingSupply?.salesCode||order.salesCode||''
                });
                incomingProductKey=productKey;
                incomingWarehouseId=warehouseId;
            }

            tx.set(supplyRef, (({id, ...record}) => record)(savedSupply));
            if(demandRef)tx.set(demandRef,demandDoc,{merge:true});
            savedDemand = { ...demandDoc, id:demandId };
            if (qty > 0) {
                items[itemIndex] = {
                    ...item, supplyOrderedQty:nextOrdered,
                    manualOrderNos:[...new Set([...(item.manualOrderNos||[]),internalNo])],
                    orderedAt:item.orderedAt && item.orderedAt < orderDate ? item.orderedAt : orderDate,
                    orderEvents:[
                        ...(item.orderEvents||[]).filter(event=>event.id!==supplyRef.id),
                        {id:supplyRef.id,type:'PURCHASING_MANUAL',at:now,date:orderDate,qty,documentNo:internalNo,by:actorName}
                    ]
                };
                savedOrder = { ...order, items, itemCount:items.length, orderSchemaVersion:2, updatedAt:now };
                tx.update(orderRef, {items, itemCount:items.length, orderSchemaVersion:2,
                    ...orderWorkIndexFields(savedOrder), updatedAt:now});
            } else {
                savedOrder = order;
            }
        });
        return { savedOrder, savedSupply, savedDemand, incomingProductKey, incomingWarehouseId };
}
// Atomic quick-purchase service end.

