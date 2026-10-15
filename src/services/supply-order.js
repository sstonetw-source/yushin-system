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
async function registerPurchaseIncoming(poId, poRecord) {
    if (isPurchaseTerminalStatus(poRecord?.status)) return;
    const supplyIds = Array.isArray(poRecord?.supplyOrderIds) ? poRecord.supplyOrderIds : [];
    for (const supplyId of supplyIds) {
        await runRoleTransaction(async tx => {
            const supplyRef = supplyOrdersCollection().doc(supplyId);
            const supplySnap = await tx.get(supplyRef);
            if (!supplySnap.exists) throw new Error(`找不到供應紀錄 ${supplyId}`);
            const supply = supplySnap.data();
            if (isPurchaseTerminalStatus(supply.status)) return;
            if ((supply.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP') return;

            const key = String(supply.productKey || supply.productId || '').trim();
            const warehouseId = String(supply.warehouseId || defaultWarehouse()?.id || '').trim();
            if (!key || !warehouseId) throw new Error(`供應紀錄 ${supplyId} 缺少產品或倉庫資料`);

            const targetQty = Math.max(0, Number(supply.qty || 0) - Number(supply.receivedQty || 0));
            const registeredQty = Math.max(0, Number(supply.incomingRegisteredQty || 0));
            const delta = targetQty - registeredQty;
            if (!delta) return;

            const invRef = db.collection('inventory').doc(encodeURIComponent(key));
            const whRef = db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,key));
            const invSnap = await tx.get(invRef);
            const whSnap = await tx.get(whRef);
            const inv = inventoryNumbers(invSnap.exists ? invSnap.data() : {});
            const wh = inventoryNumbers(whSnap.exists ? whSnap.data() : {});
            const now = new Date().toISOString();

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
            tx.set(db.collection('inventoryMovements').doc(),{
                type:'purchase_incoming',qty:delta,productKey:key,productId:supply.productId||'',warehouseId,
                brand:resolveBrandName(supply.brand||''),brandId:supply.brandId||brandIdForName(supply.brand||''),
                fulfillmentType:'WAREHOUSE',sourceType:'SUPPLY_ORDER',sourceId:supplyId,
                purchaseDocumentId:poId,createdAt:now,createdBy:currentUserName||currentUser?.email||''
            });
        });
        const supply = poRecord.items?.[Number(String(supplyId).split('-').pop())];
        const key = poIncomingKey(supply || {});
        const warehouseId = supply?.warehouseId || defaultWarehouse()?.id || '';
        if (key && warehouseId) invalidateWarehouseStockCache(key,warehouseId);
    }
}

async function cancelOutstandingSupplyRecord(poId, supplyId, reason) {
    let result={cancelledQty:0,receivedQty:0,terminalStatus:'',orderId:'',productKey:'',warehouseId:'',demandId:''};
    await runRoleTransaction(async tx => {
        const supplyRef=supplyOrdersCollection().doc(supplyId);
        const supplySnap=await tx.get(supplyRef);
        if(!supplySnap.exists)throw new Error(`找不到供應紀錄 ${supplyId}`);
        const supply=supplySnap.data()||{};
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
        const productKey=String(supply.productKey||supply.productId||'').trim();
        const warehouseId=String(supply.warehouseId||'').trim();
        result={
            cancelledQty:existingTerminal?Math.max(0,Number(supply.cancelledQty||supply.closedQty||remaining)):0,
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
        if(!directShip&&registeredIncoming>0&&(!productKey||!warehouseId||!invSnap?.exists||!whSnap?.exists)){
            throw new Error(`供應紀錄 ${supplyId} 的在途庫存資料不完整，無法安全取消。`);
        }

        const now=new Date().toISOString();
        const terminalStatus=received>0?'CLOSED':'CANCELLED';
        if(orderSnap?.exists){
            const order=orderSnap.data();
            const items=normalizedOrderItems(order);
            const itemIndex=items.findIndex(item=>String(item.itemId||'')===String(supply.itemId||''));
            if(itemIndex<0)throw new Error(`來源訂單找不到供應紀錄 ${supplyId} 對應品項。`);
            const item=items[itemIndex];
            const currentSupplyOrdered=Math.max(0,Number(item.supplyOrderedQty||0));
            const receivedForItem=Math.max(0,Number(item.receivedQty||0));
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
            const demandDoc=procurementDemandDocument(demandPlan.demand,{},{
                createdAt:demandSnap.data()?.createdAt||now,
                updatedAt:now
            });
            tx.set(demandRef,demandDoc,{merge:true});
        }

        if(invRef&&whRef){
            const inv=inventoryNumbers(invSnap.data());
            const wh=inventoryNumbers(whSnap.data());
            tx.update(invRef,{incoming:Math.max(0,inv.incoming-registeredIncoming),updatedAt:now});
            tx.update(whRef,{incoming:Math.max(0,wh.incoming-registeredIncoming),updatedAt:now});
            tx.set(db.collection('inventoryMovements').doc(),{
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
                createdBy:currentUserName||currentUser?.email||''
            });
        }

        tx.update(supplyRef,{
            status:terminalStatus,
            ...(terminalStatus==='CLOSED'?{
                closedQty:remaining,closeReason:reason,closedAt:now,
                closedByUid:currentUser?.uid||'',closedBy:currentUserName||currentUser?.email||''
            }:{
                cancelledQty:remaining,cancelReason:reason,cancelledAt:now,
                cancelledByUid:currentUser?.uid||'',cancelledBy:currentUserName||currentUser?.email||''
            }),
            incomingRegisteredQty:0,
            updatedAt:now
        });
        result={cancelledQty:remaining,receivedQty:received,terminalStatus,orderId:String(supply.orderId||''),productKey,warehouseId,demandId};
    });
    if(result.productKey&&result.warehouseId)invalidateWarehouseStockCache(result.productKey,result.warehouseId);
    if(result.demandId)invalidateProcurementDemandQueue();
    return result;
}

window.cancelSupplyOutstanding = async function(supplyId) {
    if (!canCreatePurchaseOrderCapability()) {
        alert('只有管理員或採購可以取消採購的未到貨數量。');
        return;
    }
    const actionKey = `supply:${supplyId}`;
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
    try {
        const result = await cancelOutstandingSupplyRecord(
            supply.purchaseDocumentId || supply.internalNo || supply.id,
            supply.id,
            reason
        );
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
        alert('取消採購品項失敗：' + (err?.message || err) + '。可以重新執行；已成功的異動不會重複扣除。');
    } finally {
        purchaseCancellationInProgress.delete(actionKey);
        if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
        if (document.getElementById('inventory-system')?.classList.contains('active') && inventoryReceivingVisible) renderPurchasingReceivingWorkList(null, null, null, null, true);
    }
};

window.cancelPurchaseOrderOutstanding = async function(poId) {
    if(!canCreatePurchaseOrderCapability()){alert('只有管理員或採購可以停止採購單未到貨數量。');return;}
    if(purchaseCancellationInProgress.has(poId))return;
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
    try{
        let cancelledQty=0;
        let receivedQty=0;
        const affectedOrderIds=new Set();
        for(const supplyId of supplyIds){
            const result=await cancelOutstandingSupplyRecord(poId,supplyId,reason);
            cancelledQty+=Math.max(0,Number(result.cancelledQty||0));
            receivedQty+=Math.max(0,Number(result.receivedQty||0));
            if(result.orderId)affectedOrderIds.add(result.orderId);
        }
        if(cancelledQty<=0){
            alert('這張採購單目前沒有尚未到貨的數量可取消。');
            return;
        }
        const now=new Date().toISOString();
        const documentStatus=receivedQty>0?'CLOSED':'CANCELLED';
        const patch={
            status:documentStatus,
            stoppedQty:cancelledQty,
            ...(documentStatus==='CLOSED'?{
                closedQty:cancelledQty,closeReason:reason,closedAt:now,
                closedByUid:currentUser?.uid||'',closedBy:currentUserName||currentUser?.email||''
            }:{
                cancelledQty,cancelReason:reason,cancelledAt:now,
                cancelledByUid:currentUser?.uid||'',cancelledBy:currentUserName||currentUser?.email||''
            }),
            updatedAt:now
        };
        await db.collection('purchaseOrders').doc(poId).set(patch,{merge:true});
        const applyPatch=row=>row?.id===poId?Object.assign(row,patch):row;
        poListCache.forEach(applyPatch);
        poHistorySearchResults.forEach(applyPatch);
        supplyReceivingCache=supplyReceivingCache.filter(row=>!supplyIds.includes(row.id));
        if(affectedOrderIds.size)await refreshAffectedOrderCaches([...affectedOrderIds]);
        writeAppDataCache('purchase-history',poListCache);
        if(document.getElementById('purchasing-system')?.classList.contains('active'))renderPurchasingView();
        else renderPoList();
        showActionFeedback(`${documentStatus==='CLOSED'?'已結案':'已取消'} ${po.poNo||poId}；停止未到貨數量 ${cancelledQty}，在途庫存與來源訂單待採購量已同步。`,'success');
    }catch(err){
        console.error('停止採購單未到貨失敗：',err);
        alert('停止未完全完成：'+(err?.message||err)+'。可以再次執行同一動作；已完成的供應紀錄不會重複扣除。');
    }finally{
        purchaseCancellationInProgress.delete(poId);
    }
};

let poReceiptTargetId = '';
let poReceiptOperationId = '';

