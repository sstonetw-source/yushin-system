/* =========================================================
   產生採購單：採購把選好的訂單品項，整理成一張要發給供應商的「採購單」，
   格式跟估價單相同，但抬頭是供應商、單價預設帶「含稅成本」而不是賣客戶的售價，
   而且單價在這裡還可以再調整；也可以切換又鑫／辰星／鼎新，套用各公司的抬頭資訊跟單號代碼
   ========================================================= */
let poItems = [];
let poAllItems = [];
let poCurrentCompany = 'yushin';
let poEditingId = null;
let poSaveInProgress = false;
let poDirectStockMode = false;
let poIncomingSyncPending = false;
let poNoGeneration = 0;
let poDirectStockOpenGeneration = 0;
let poNoReady = false;
let poNoLoading = false;
const purchaseCancellationInProgress = new Set();

function updatePoSaveStatus(message = '', isError = false) {
    const status = document.getElementById('poSaveStatus');
    if (!status) return;
    status.textContent = message;
    status.style.color = isError ? '#b42318' : '#12502b';
}

function updatePoSaveButton() {
    const button = document.getElementById('printPurchaseOrderBtn');
    if (!button) return;
    const waitingForNumber = !poEditingId && !poNoReady;
    const copyButton = document.getElementById('poCopyAsNewBtn');
    if (copyButton) copyButton.disabled = poSaveInProgress;
    button.disabled = poSaveInProgress || waitingForNumber;
    button.textContent = waitingForNumber
        ? (poNoLoading ? '產生單號中…' : '單號未就緒')
        : poEditingId ? '📄 下載 PDF' : '📄 建立採購單並下載 PDF';
}

function poIncomingKey(item) {
    return String(item.productId || (item.itemCode ? `code:${normalizeHistoryItemCode(item.itemCode)}` : '')).trim();
}
async function registerPurchaseIncoming(poId, poRecord, {actorUid=currentUser?.uid,actorRole=currentUserRole}={}) {
    if (isPurchaseTerminalStatus(poRecord?.status)) return;
    const assertActor=()=>{
        if (!actorUid || currentUser?.uid!==actorUid || currentUserRole!==actorRole) throw new Error('登入身份已變更，請以原帳號重試在途同步。');
        if (!canCreatePurchaseOrderCapability() || !canAccessPage('orders.po')) throw new Error('目前無採購作業權限。');
    };
    const quantity=(value,label,optional=false)=>{
        if (value===undefined&&optional) return 0;
        if ((typeof value!=='number'&&typeof value!=='string') || (typeof value==='string'&&!value.trim())
            || !Number.isFinite(Number(value)) || Number(value)<0) throw new Error(`${label}數量異常，請先核對紀錄。`);
        return Number(value);
    };
    assertActor();
    if (!globalThis.YushinReceiving?.normalizeSupply) throw new Error('Receiving core 未載入，無法同步在途庫存。');
    const supplyIds = [...new Set(Array.isArray(poRecord?.supplyOrderIds) ? poRecord.supplyOrderIds : [])];
    const now=new Date().toISOString(), actorName=currentUserName||currentUser?.email||'';
    for (const supplyId of supplyIds) {
        assertActor();
        const movementRef=db.collection('inventoryMovements').doc();
        let committedStock=null;
        await runRoleTransaction(async tx => {
            assertActor();
            committedStock=null;
            const supplyRef = supplyOrdersCollection().doc(supplyId);
            const [poSnap,supplySnap] = await Promise.all([tx.get(db.collection('purchaseOrders').doc(poId)),tx.get(supplyRef)]);
            assertActor();
            if (!poSnap.exists) throw new Error('找不到來源採購單，請先核對同步結果。');
            const livePo=poSnap.data();
            if (!Array.isArray(livePo.supplyOrderIds)||!livePo.supplyOrderIds.includes(supplyId)) throw new Error('採購單供應連結已變更，請重新開啟原單。');
            if (isPurchaseTerminalStatus(livePo.status)) return;
            if (!supplySnap.exists) throw new Error(`找不到供應紀錄 ${supplyId}`);
            const supply = supplySnap.data();
            if (supply.type!=='PURCHASING_PO'||supply.purchaseDocumentId!==poId) throw new Error('供應紀錄不屬於這張採購單，請先核對原單。');
            if (isPurchaseTerminalStatus(supply.status)) return;
            if ((supply.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP') return;

            const key = String(supply.productKey || supply.productId || '').trim();
            const warehouseId = String(supply.warehouseId || '').trim();
            if (!key || !warehouseId) throw new Error(`供應紀錄 ${supplyId} 缺少產品或倉庫資料`);

            const orderedQty=quantity(supply.qty,'採購');
            const receivedQty=quantity(supply.receivedQty,'到貨',true);
            if (receivedQty>orderedQty) throw new Error('到貨量超過採購量，請先核對供應紀錄。');
            quantity(supply.incomingRegisteredQty,'已登記在途',true);
            const projection=globalThis.YushinReceiving.normalizeSupply(supply);
            const targetQty = projection.remainingQty;
            const registeredQty = projection.incomingRegisteredQty;
            const delta = targetQty - registeredQty;
            if (!delta) return;

            const invRef = db.collection('inventory').doc(encodeURIComponent(key));
            const whRef = db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,key));
            const invSnap = await tx.get(invRef);
            const whSnap = await tx.get(whRef);
            assertActor();
            if ((invSnap.exists&&invSnap.data().productKey&&invSnap.data().productKey!==key)
                || (whSnap.exists&&((whSnap.data().productKey&&whSnap.data().productKey!==key)
                    ||(whSnap.data().warehouseId&&whSnap.data().warehouseId!==warehouseId))))
                throw new Error('公司或分倉庫存識別不符，請先核對紀錄。');
            const companyIncoming=quantity(invSnap.exists?invSnap.data().incoming:undefined,'公司在途',true);
            const warehouseIncoming=quantity(whSnap.exists?whSnap.data().incoming:undefined,'分倉在途',true);
            if (companyIncoming+delta < -1e-9 || warehouseIncoming+delta < -1e-9) throw new Error('在途保留量不足，無法完整修正，請先核對公司與分倉庫存。');
            const inv = inventoryNumbers(invSnap.exists ? invSnap.data() : {});
            const wh = inventoryNumbers(whSnap.exists ? whSnap.data() : {});

            if (invSnap.exists) {
                tx.set(invRef,{
                    incoming:Math.max(0,inv.incoming+delta),
                    brand:resolveBrandName(supply.brand||''),
                    brandId:supply.brandId||brandIdForName(supply.brand||''),
                    updatedAt:now
                },{merge:true});
            } else {
                const nextInventory={
                    productKey:key,productId:supply.productId||'',itemCode:supply.itemCode||'',itemName:supply.itemName||'',
                    brand:resolveBrandName(supply.brand||''),brandId:supply.brandId||brandIdForName(supply.brand||''),onHand:0,reserved:0,incoming:Math.max(0,delta),lots:[],updatedAt:now
                };
                nextInventory.searchTokens=buildInventorySearchTokens(nextInventory);
                tx.set(invRef,nextInventory,{merge:true});
            }
            tx.set(whRef,{
                warehouseId,productKey:key,productId:supply.productId||'',itemCode:supply.itemCode||'',
                itemName:supply.itemName||'',brand:resolveBrandName(supply.brand||''),brandId:supply.brandId||brandIdForName(supply.brand||''),
                onHand:wh.onHand,reserved:wh.reserved,incoming:Math.max(0,wh.incoming+delta),updatedAt:now
            },{merge:true});
            tx.update(supplyRef,{incomingRegisteredQty:targetQty,incomingRegisteredAt:now,updatedAt:now});
            tx.set(movementRef,{
                type:'purchase_incoming',qty:delta,productKey:key,productId:supply.productId||'',warehouseId,
                brand:resolveBrandName(supply.brand||''),brandId:supply.brandId||brandIdForName(supply.brand||''),
                fulfillmentType:'WAREHOUSE',sourceType:'SUPPLY_ORDER',sourceId:supplyId,
                purchaseDocumentId:poId,createdAt:now,createdBy:actorName
            });
            committedStock={key,warehouseId};
        });
        assertActor();
        if (committedStock) invalidateWarehouseStockCache(committedStock.key,committedStock.warehouseId);
    }
}

async function cancelOutstandingSupplyRecord(poId, supplyId, reason, {actorUid=currentUser?.uid,actorRole=currentUserRole}={}) {
    const assertActor=()=>{
        if (!actorUid||currentUser?.uid!==actorUid||currentUserRole!==actorRole) throw new Error('登入身份已變更，請以原帳號重試取消。');
        if (!canCreatePurchaseOrderCapability()) throw new Error('目前無採購取消權限。');
    };
    const quantity=(value,label,optional=false)=>{
        if(value===undefined&&optional)return 0;
        if((typeof value!=='number'&&typeof value!=='string')||(typeof value==='string'&&!value.trim())||!Number.isFinite(Number(value))||Number(value)<0)
            throw new Error(`${label}數量異常，請先核對紀錄。`);
        return Number(value);
    };
    if(typeof reason!=='string'||!reason.trim())throw new Error('請填寫取消原因。');
    reason=reason.trim();assertActor();
    const now=new Date().toISOString(),actorName=currentUserName||currentUser?.email||'';
    const movementRef=db.collection('inventoryMovements').doc();
    let result={cancelledQty:0,receivedQty:0,terminalStatus:'',orderId:'',productKey:'',warehouseId:'',demandId:''};
    await runRoleTransaction(async tx => {
        assertActor();
        const supplyRef=supplyOrdersCollection().doc(supplyId);
        const supplySnap=await tx.get(supplyRef);
        assertActor();
        if(!supplySnap.exists)throw new Error(`找不到供應紀錄 ${supplyId}`);
        const supply=supplySnap.data()||{};
        if(!['PURCHASING_MANUAL','PURCHASING_PO'].includes(supply.type)
            ||(supply.purchaseDocumentId||supply.internalNo||supplyId)!==poId)throw new Error('供應紀錄與本次採購取消來源不符。');
        if(supply.type==='PURCHASING_PO'){
            const poSnap=await tx.get(db.collection('purchaseOrders').doc(poId));assertActor();
            if(!poSnap.exists||!Array.isArray(poSnap.data().supplyOrderIds)||!poSnap.data().supplyOrderIds.includes(supplyId))
                throw new Error('採購單供應連結不完整，請先核對原單。');
        }
        const rawQty=quantity(supply.qty,'採購'),rawReceived=quantity(supply.receivedQty,'到貨',true);
        if(rawReceived>rawQty)throw new Error('到貨量超過採購量，無法安全取消。');
        quantity(supply.incomingRegisteredQty,'已登記在途',true);
        if (!globalThis.YushinReceiving?.normalizeSupply) {
            throw new Error('Receiving core 未載入，無法計算取消數量。');
        }
        const supplyProjection=globalThis.YushinReceiving.normalizeSupply(supply);
        const ordered=supplyProjection.qty;
        const received=supplyProjection.receivedQty;
        const existingTerminal=isPurchaseTerminalStatus(supplyProjection.status);
        const remaining=existingTerminal
            ? Math.max(0,ordered-received)
            : supplyProjection.remainingQty;
        const stoppedQty=existingTerminal?quantity(supply.closedQty??supply.cancelledQty??remaining,'已停止'):0;
        if(existingTerminal&&Math.abs(stoppedQty-remaining)>1e-9)throw new Error('已停止數量與供應餘量不符，請先核對紀錄。');
        if(existingTerminal&&Number(supply.incomingRegisteredQty||0)!==0)throw new Error('終止供應仍保留在途量，請先核對紀錄。');
        const productKey=String(supply.productKey||supply.productId||'').trim();
        const warehouseId=String(supply.warehouseId||'').trim();
        result={
            cancelledQty:stoppedQty,
            receivedQty:received,
            terminalStatus:existingTerminal?supplyProjection.status:'',
            orderId:String(supply.orderId||''),
            productKey,
            warehouseId,
            demandId:String(supply.demandId||'')
        };
        if(existingTerminal||remaining<=0)return;

        const directShip=(supply.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP';
        const registeredIncoming=Math.max(0,Number(supply.incomingRegisteredQty||0));
        if(directShip&&registeredIncoming>0)throw new Error('直送供應不應有公司倉庫在途量，請先核對紀錄。');
        const orderRef=supply.orderId?db.collection('orders').doc(supply.orderId):null;
        const invRef=!directShip&&registeredIncoming>0&&productKey
            ? db.collection('inventory').doc(encodeURIComponent(productKey)):null;
        const whRef=!directShip&&registeredIncoming>0&&productKey&&warehouseId
            ? db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,productKey)):null;
        const demandId=String(supply.demandId||'').trim();
        const demandRef=demandId?procurementDemandRef(demandId):null;

        // Read every linked document before the first write. This mirrors ERPNext's
        // status-updater model: the demand document is updated from the PO line change.
        const orderSnap=orderRef?await tx.get(orderRef):null;
        const invSnap=invRef?await tx.get(invRef):null;
        const whSnap=whRef?await tx.get(whRef):null;
        const demandSnap=demandRef?await tx.get(demandRef):null;
        assertActor();
        if(orderRef&&!orderSnap?.exists)throw new Error('來源訂單不存在，無法完整取消供應承諾。');
        if(demandRef&&!demandSnap?.exists)throw new Error('來源採購需求不存在，無法完整取消供應承諾。');
        if(!directShip&&registeredIncoming>0&&(!productKey||!warehouseId||!invSnap?.exists||!whSnap?.exists)){
            throw new Error(`供應紀錄 ${supplyId} 的在途庫存資料不完整，無法安全取消。`);
        }

        const terminalStatus=received>0?'CLOSED':'CANCELLED';
        if(orderSnap?.exists){
            const order=orderSnap.data();
            const items=normalizedOrderItems(order);
            const itemIndex=items.findIndex(item=>String(item.itemId||'')===String(supply.itemId||''));
            if(itemIndex<0)throw new Error(`來源訂單找不到供應紀錄 ${supplyId} 對應品項。`);
            const item=items[itemIndex];
            const currentSupplyOrdered=quantity(item.supplyOrderedQty,'訂單供應承諾',true);
            const receivedForItem=quantity(item.receivedQty,'訂單已到貨',true);
            if(currentSupplyOrdered-remaining<receivedForItem-1e-9)throw new Error('訂單供應承諾不足以完整取消，請先核對來源數量。');
            items[itemIndex]={
                ...item,
                supplyOrderedQty:Math.max(receivedForItem,currentSupplyOrdered-remaining)
            };
            const nextOrder={...order,items,itemCount:items.length,orderSchemaVersion:2,updatedAt:now};
            tx.update(orderRef,{
                items,itemCount:items.length,orderSchemaVersion:2,
                ...orderWorkIndexFields(nextOrder),updatedAt:now
            });
        }

        if(demandRef&&demandSnap?.exists){
            if(!globalThis.YushinProcurementDemand?.applySupplyCancellation){
                throw new Error('Procurement Demand core 未載入，無法重新開啟採購需求。');
            }
            const demandPlan=globalThis.YushinProcurementDemand.applySupplyCancellation(demandSnap.data()||{},supply);
            const demandBefore=demandSnap.data();
            const demandOrdered=quantity(demandBefore.orderedQty,'需求供應承諾',true);
            const demandReceived=quantity(demandBefore.receivedQty,'需求已到貨',true);
            if(demandPlan.releasedQty!==remaining||demandOrdered-remaining<demandReceived-1e-9)
                throw new Error('需求供應承諾不足以完整取消，請先核對來源數量。');
            const demandDoc=procurementDemandDocument(demandPlan.demand,{},{
                createdAt:demandSnap.data()?.createdAt||now,
                updatedAt:now
            });
            tx.set(demandRef,demandDoc,{merge:true});
        }

        if(invRef&&whRef){
            const inv=inventoryNumbers(invSnap.data());
            const wh=inventoryNumbers(whSnap.data());
            const companyIncoming=quantity(invSnap.data().incoming,'公司在途',true);
            const warehouseIncoming=quantity(whSnap.data().incoming,'分倉在途',true);
            if(companyIncoming<registeredIncoming-1e-9||warehouseIncoming<registeredIncoming-1e-9)throw new Error('在途保留量不足以完整扣回，取消未提交。');
            if((invSnap.data().productKey&&invSnap.data().productKey!==productKey)
                ||(whSnap.data().productKey&&whSnap.data().productKey!==productKey)
                ||(whSnap.data().warehouseId&&whSnap.data().warehouseId!==warehouseId))throw new Error('公司或分倉庫存識別不符。');
            tx.update(invRef,{incoming:Math.max(0,inv.incoming-registeredIncoming),updatedAt:now});
            tx.update(whRef,{incoming:Math.max(0,wh.incoming-registeredIncoming),updatedAt:now});
            tx.set(movementRef,{
                type:terminalStatus==='CLOSED'?'purchase_incoming_close':'purchase_incoming_cancel',
                qty:-registeredIncoming,
                productKey,warehouseId,
                fulfillmentType:'WAREHOUSE',
                sourceType:'SUPPLY_ORDER',
                sourceId:supplyId,
                purchaseDocumentId:poId,
                reason,
                ownerUid:supply.ownerUid||'',
                salesCode:supply.salesCode||'',
                createdAt:now,
                createdBy:actorName
            });
        }

        tx.update(supplyRef,{
            status:terminalStatus,
            ...(terminalStatus==='CLOSED'?{
                closedQty:remaining,closeReason:reason,closedAt:now,
                closedByUid:actorUid,closedBy:actorName
            }:{
                cancelledQty:remaining,cancelReason:reason,cancelledAt:now,
                cancelledByUid:actorUid,cancelledBy:actorName
            }),
            incomingRegisteredQty:0,
            updatedAt:now
        });
        result={cancelledQty:remaining,receivedQty:received,terminalStatus,orderId:String(supply.orderId||''),productKey,warehouseId,demandId};
    });
    assertActor();
    if(result.productKey&&result.warehouseId)invalidateWarehouseStockCache(result.productKey,result.warehouseId);
    if(result.demandId)invalidateProcurementDemandQueue();
    return result;
}

async function stopPurchaseOrderOutstanding(poId,reason,{actorUid=currentUser?.uid,actorRole=currentUserRole}={}) {
    const assertActor=()=>{
        if(!actorUid||currentUser?.uid!==actorUid||currentUserRole!==actorRole)throw new Error('登入身份已變更，請以原帳號重試取消。');
        if(!canCreatePurchaseOrderCapability())throw new Error('目前無採購取消權限。');
    };
    if(typeof reason!=='string'||!reason.trim())throw new Error('請填寫取消原因。');
    reason=reason.trim();assertActor();
    const actor={actorUid,actorRole},actorName=currentUserName||currentUser?.email||'',now=new Date().toISOString();
    const ref=db.collection('purchaseOrders').doc(poId);
    const supplyIds=await runRoleTransaction(async tx=>{
        const snapshot=await tx.get(ref);assertActor();
        if(!snapshot.exists)throw new Error('找不到這張採購單。');
        const ids=snapshot.data().supplyOrderIds;
        if(!Array.isArray(ids)||!ids.length||ids.some(id=>typeof id!=='string'||!id))throw new Error('採購單沒有完整供應連結。');
        return [...new Set(ids)];
    });
    const affectedOrderIds=new Set();
    for(const supplyId of supplyIds){
        assertActor();
        const result=await cancelOutstandingSupplyRecord(poId,supplyId,reason,actor);
        if(result.orderId)affectedOrderIds.add(result.orderId);
    }
    let patch=null,cancelledQty=0,receivedQty=0;
    await runRoleTransaction(async tx=>{
        assertActor();patch=null;cancelledQty=receivedQty=0;
        const snapshot=await tx.get(ref);
        const supplies=await Promise.all(supplyIds.map(id=>tx.get(supplyOrdersCollection().doc(id))));
        assertActor();
        if(!snapshot.exists)throw new Error('來源採購單已不存在。');
        const live=snapshot.data(),ids=Array.isArray(live.supplyOrderIds)?[...new Set(live.supplyOrderIds)]:[];
        if(JSON.stringify(ids.slice().sort())!==JSON.stringify(supplyIds.slice().sort()))throw new Error('採購單供應連結已變更，請重新執行取消。');
        supplies.forEach(snap=>{
            if(!snap.exists)throw new Error('採購單供應紀錄不完整。');
            const supply=snap.data();
            if(supply.type!=='PURCHASING_PO'||supply.purchaseDocumentId!==poId)throw new Error('供應紀錄不屬於這張採購單。');
            for(const field of ['qty','receivedQty','incomingRegisteredQty']){
                const value=supply[field]===undefined&&field!=='qty'?0:supply[field];
                if((typeof value!=='number'&&typeof value!=='string')||(typeof value==='string'&&!value.trim())||!Number.isFinite(Number(value))||Number(value)<0)
                    throw new Error('供應數量異常，無法結清採購單。');
            }
            const projection=globalThis.YushinReceiving.normalizeSupply(supply);
            const stopped=Number(supply.closedQty??supply.cancelledQty??(projection.qty-projection.receivedQty));
            if(!Number.isFinite(stopped)||stopped<0||projection.qty!==Number(supply.qty)||projection.receivedQty!==Number(supply.receivedQty||0)
                ||projection.incomingRegisteredQty!==Number(supply.incomingRegisteredQty||0))throw new Error('供應數量已變更或異常，無法結清採購單。');
            if(!isPurchaseTerminalStatus(projection.status)&&projection.remainingQty>0)throw new Error('尚有供應品項未停止，採購單不能結清。');
            receivedQty+=projection.receivedQty;
            if(isPurchaseTerminalStatus(projection.status)){
                if(projection.incomingRegisteredQty!==0)throw new Error('供應在途尚未釋放，採購單不能結清。');
                if(Math.abs(stopped-(projection.qty-projection.receivedQty))>1e-9)throw new Error('供應停止量與餘量不符，採購單不能結清。');
                cancelledQty+=stopped;
            }
        });
        if(isPurchaseTerminalStatus(live.status)){patch=live;return;}
        if(cancelledQty<=0)return;
        const documentStatus=receivedQty>0?'CLOSED':'CANCELLED';
        patch={status:documentStatus,stoppedQty:cancelledQty,
            ...(documentStatus==='CLOSED'?{closedQty:cancelledQty,closeReason:reason,closedAt:now,closedByUid:actorUid,closedBy:actorName}
                :{cancelledQty,cancelReason:reason,cancelledAt:now,cancelledByUid:actorUid,cancelledBy:actorName}),updatedAt:now};
        tx.update(ref,patch);
    });
    assertActor();
    return {patch,cancelledQty,receivedQty,supplyIds,affectedOrderIds:[...affectedOrderIds]};
}

window.cancelSupplyOutstanding = async function(supplyId) {
    if (!canCreatePurchaseOrderCapability()) {
        alert('只有管理員或採購可以取消採購的未到貨數量。');
        return;
    }
    const actionKey = `supply:${supplyId}`;
    const actorUid=currentUser?.uid,actorRole=currentUserRole;
    if (purchaseCancellationInProgress.has(actionKey)) return;

    let supply;
    try {
        const snapshot = await firestoreReadWithTimeout(
            supplyOrdersCollection().doc(supplyId).get(),
            '讀取採購品項狀態'
        );
        if (!snapshot.exists) throw new Error('找不到這筆供應紀錄。');
        supply = { id:snapshot.id, ...snapshot.data() };
    } catch (err) {
        alert('無法讀取採購品項：' + (err?.message || err));
        return;
    }

    if (!['PURCHASING_MANUAL', 'PURCHASING_PO'].includes(supply.type)) {
        alert('此採購方式不支援在這裡取消。');
        return;
    }
    if (isPurchaseTerminalStatus(supply.status)) {
        const label=String(supply.status||'').toUpperCase()==='CLOSED'?'已結案':'已取消';
        showActionFeedback(`這筆採購${label}，沒有待處理的未到貨數量。`, 'success');
        return;
    }
    const remaining = Math.max(0, Number(supply.qty || 0) - Number(supply.receivedQty || 0));
    if (remaining <= 0) {
        alert('這筆採購已全部到貨，沒有可取消的未到貨數量。');
        return;
    }

    const reasonRaw = prompt(
        `取消品項 ${supply.itemCode || supply.itemName || supply.id} 尚未到貨的 ${remaining} 個。\n採購單：${supply.purchaseDocumentNo || supply.internalNo || supply.id}\n只取消此品項，其他品項不受影響；已到貨的數量不回沖。\n來源訂單仍有效時，未滿足的數量會重新列入待採購。\n\n請輸入原因：`
    );
    if (reasonRaw === null) return;
    const reason = String(reasonRaw || '').trim();
    if (!reason) {
        alert('請填寫取消原因，方便後續追蹤。');
        return;
    }

    purchaseCancellationInProgress.add(actionKey);
    if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
    let supplyStopped=false;
    try {
        const result = await cancelOutstandingSupplyRecord(
            supply.purchaseDocumentId || supply.internalNo || supply.id,
            supply.id,
            reason,{actorUid,actorRole}
        );
        supplyStopped=true;
        purchaseHistorySupplyCache.set(supply.id, {...supply, status:result.terminalStatus,
            incomingRegisteredQty:0, ...(result.terminalStatus === 'CLOSED' ? {closedQty:result.cancelledQty} : {cancelledQty:result.cancelledQty})});
        supplyReceivingCache = supplyReceivingCache.filter(row => row.id !== supply.id);
        try {
            await loadActiveReceivingSupplyCache(true);
            if (result.orderId) await refreshAffectedOrderCaches([result.orderId]);
        } catch (refreshError) {
            markMainPageDirty('orders.po');
            showActionFeedback('取消已完成，但清單更新失敗；請重新開啟採購頁確認。', 'warning');
            console.warn('取消後更新清單失敗', refreshError);
        }
        if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
        showActionFeedback(
            `${result.terminalStatus==='CLOSED'?'已結案':'已取消'}採購品項 ${supply.itemCode || supply.itemName || supply.id}；取消未到貨數量 ${result.cancelledQty || remaining}，在途庫存已同步。`,
            'success'
        );
    } catch (err) {
        console.error('取消採購品項未到貨失敗：', err);
        alert(supplyStopped?'取消已完成，但畫面更新失敗；請重新開啟採購頁確認：'+(err?.message||err)
            :'取消採購品項失敗：' + (err?.message || err) + '。可以重新執行；已成功的異動不會重複扣除。');
    } finally {
        purchaseCancellationInProgress.delete(actionKey);
        if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
        if (document.getElementById('inventory-system')?.classList.contains('active') && inventoryReceivingVisible) renderPurchasingReceivingWorkList(null, null, null, null, true);
    }
};

window.cancelPurchaseOrderOutstanding = async function(poId) {
    if(!canCreatePurchaseOrderCapability()){alert('只有管理員或採購可以停止採購單未到貨數量。');return;}
    if(purchaseCancellationInProgress.has(poId))return;
    const actorUid=currentUser?.uid,actorRole=currentUserRole;
    const cached=poListCache.find(po=>po.id===poId)||poHistorySearchResults.find(po=>po.id===poId);
    let po=cached;
    try{
        const fresh=await firestoreReadWithTimeout(db.collection('purchaseOrders').doc(poId).get(),'讀取採購單取消狀態');
        if(!fresh.exists)throw new Error('找不到這張採購單。');
        po={id:fresh.id,...fresh.data()};
    }catch(err){
        alert('無法讀取採購單：'+(err?.message||err));
        return;
    }
    if(isPurchaseTerminalStatus(po.status)){
        const label=String(po.status||'').toUpperCase()==='CLOSED'?'已結案':'已取消';
        showActionFeedback(`這張採購單${label}，沒有待處理的未到貨數量。`,'success');
        return;
    }
    const reasonRaw=prompt(`停止採購單 ${po.poNo||po.id} 尚未到貨的數量。\n已實際到貨的數量不會回沖；若已有到貨紀錄，採購單會標示為「已結案」，完全未到貨才標示為「已取消」。\n原訂單會重新出現尚需採購的數量。\n\n請輸入原因：`);
    if(reasonRaw===null)return;
    const reason=String(reasonRaw||'').trim();
    if(!reason){alert('請填寫取消原因，方便後續追蹤。');return;}
    const supplyIds=Array.isArray(po.supplyOrderIds)?po.supplyOrderIds.filter(Boolean):[];
    if(!supplyIds.length){alert('這張採購單沒有可追蹤的供應紀錄，無法安全取消。');return;}

    purchaseCancellationInProgress.add(poId);
    let stopCommitted=false;
    try{
        const {patch,cancelledQty,supplyIds:committedSupplyIds,affectedOrderIds}=await stopPurchaseOrderOutstanding(poId,reason,{actorUid,actorRole});
        if(!patch){alert('這張採購單目前沒有尚未到貨的數量可取消。');return;}
        stopCommitted=true;
        const documentStatus=patch.status;
        const applyPatch=row=>row?.id===poId?Object.assign(row,patch):row;
        poListCache.forEach(applyPatch);
        poHistorySearchResults.forEach(applyPatch);
        supplyReceivingCache=supplyReceivingCache.filter(row=>!committedSupplyIds.includes(row.id));
        try{
            if(affectedOrderIds.length)await refreshAffectedOrderCaches(affectedOrderIds);
        }catch(refreshError){
            markMainPageDirty('orders.po');
            console.warn('停止採購後更新清單失敗',refreshError);
            showActionFeedback('停止採購已完成，但清單更新失敗；請重新開啟採購頁確認。','warning');
        }
        writeAppDataCache('purchase-history',poListCache);
        if(document.getElementById('purchasing-system')?.classList.contains('active'))renderPurchasingView();
        else renderPoList();
        showActionFeedback(`${documentStatus==='CLOSED'?'已結案':'已取消'} ${po.poNo||poId}；停止未到貨數量 ${cancelledQty}，在途庫存與來源訂單待採購量已同步。`,'success');
    }catch(err){
        console.error('停止採購單未到貨失敗：',err);
        alert(stopCommitted?'停止採購已完成，但畫面更新失敗；請重新開啟採購頁確認：'+(err?.message||err)
            :'停止未完全完成：'+(err?.message||err)+'。可以再次執行同一動作；已完成的供應紀錄不會重複扣除。');
    }finally{
        purchaseCancellationInProgress.delete(poId);
    }
};

let poReceiptTargetId = '';
let poReceiptOperationId = '';

