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

function receiptOperationStorageKey(supplyId, ownerUid = currentUser?.uid || '') {
    return `yushin-receipt-operation:${ownerUid}:${String(supplyId || '')}`;
}
function ensureReceiptOperationId(supplyId) {
    const key=receiptOperationStorageKey(supplyId);
    let operationId='';
    try { operationId=sessionStorage.getItem(key)||''; } catch (_) {}
    if(!operationId){
        operationId=`receipt-${Date.now()}-${Math.random().toString(36).slice(2,10)}`;
        try { sessionStorage.setItem(key,operationId); } catch (_) {}
    }
    poReceiptOperationId=operationId;
    return operationId;
}
function clearReceiptOperationId(supplyId, completedOperationId = '', ownerUid = currentUser?.uid || '') {
    try {
        const key=receiptOperationStorageKey(supplyId,ownerUid);
        if(!completedOperationId||sessionStorage.getItem(key)===completedOperationId)sessionStorage.removeItem(key);
    } catch (_) {}
    if(currentUser?.uid===ownerUid&&(!completedOperationId||poReceiptOperationId===completedOperationId))poReceiptOperationId='';
}
window.closePoReceiptBatch = function() {
    document.getElementById('poReceiptBatchOverlay')?.classList.remove('active');
    const body=document.getElementById('poReceiptBatchBody');
    if(body)body.innerHTML='';
    poReceiptTargetId='';
};


window.receiveSupplyOrder = function(supplyId) {
    if (!canReceiveInventoryCapability()) { alert('您沒有到貨入庫權限。'); return; }
    if (receiptTaskBlocksSupply(supplyId)) return;
    const supply=pendingSupplyCache.find(row=>row.id===supplyId);
    if(!supply)return;
    const remaining=Math.max(0,Number(supply.qty||0)-Number(supply.receivedQty||0));
    if(remaining<=0){alert('這筆訂貨已全部入庫。');return;}
    poReceiptTargetId='supply:'+supplyId;
    ensureReceiptOperationId(supplyId);
    const directShip=(supply.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP';
    const title=document.getElementById('poReceiptBatchTitle');
    if(title)title.textContent=directShip ? `原廠直送到貨｜${supply.internalNo||supplyId}` : `到貨入庫｜${supply.internalNo||supplyId}`;
    const body=document.getElementById('poReceiptBatchBody');
    body.innerHTML=`<tr data-index="0">
      <td><input type="checkbox" class="po-receive-select" checked></td>
      <td>${escapeHtml(supply.itemCode||'')}</td>
      <td>${escapeHtml(supply.itemName||'')}</td>
      <td>${Number(supply.qty||0)}</td><td>${Number(supply.receivedQty||0)}</td><td>${remaining}</td>
      <td><input type="number" class="po-receive-qty" min="0" max="${remaining}" step="any" value="${remaining}" style="width:85px;"></td>
      <td><input type="text" class="po-receive-lot" placeholder="批號"></td>
      <td><input type="date" class="po-receive-expiry"></td>
    </tr>`;
    document.getElementById('poReceiptBatchOverlay')?.classList.add('active');
};

async function allocateFreeReceiptStockToShortages(productKey,warehouseId,maxQty,actor,excludeOrderId='',receiptId='',checkpointCollection='receipts',allocationGuard=null) {
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
        const candidate=candidates.filter(Boolean).sort(compare)[0];
        if(!candidate){completionReason='no-demand';break;}
        let took=0,skipCandidate=false,stopAllocation=false;
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
            const inv=inventoryNumbers(invSnap.exists?invSnap.data():{}),wh=inventoryNumbers(whSnap.data());
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
            const take=Math.min(remaining,receiptRemaining,liveShortage,oldShortage,uncovered,Math.max(0,wh.available),Math.max(0,inv.available));
            if(take<=0){completionReason='exhausted';stopAllocation=true;return;}
            items[index]={...item,reservedQty:oldReserved+take,shortageQty:Math.max(0,oldShortage-take)};
            const now=new Date().toISOString();
            const nextOrder={...order,items,updatedAt:now};
            tx.update(orderRef,{items,...orderWorkIndexFields(nextOrder),updatedAt:now});
            const demand=procurementDemandForOrderItem(nextOrder,items[index]);
            tx.set(demandRef,procurementDemandDocument({...(demandSnap.exists?demandSnap.data():{}),...demand},{
                sourceItemIndex:index,productId:item.productId||'',productKey,
                itemCode:item.itemCode||'',itemName:item.itemName||'',brand:item.brand||'',
                fulfillmentType:'WAREHOUSE',warehouseId,ownerUid:order.ownerUid||'',
                salesCode:order.salesCode||'',salesName:order.salesName||''
            },{createdAt:demandSnap.exists?demandSnap.data().createdAt:order.createdAt||now,updatedAt:now}),{merge:true});
            tx.update(reservationRef,{quantity:Number(reservation.quantity||0)+take,shortageQty:Math.max(0,liveShortage-take),status:'active',updatedAt:now});
            if(invSnap.exists)tx.update(invRef,{reserved:inv.reserved+take,updatedAt:now});
            tx.update(whRef,{reserved:wh.reserved+take,updatedAt:now});
            if(receiptRef){
                const nextAllocated=receiptAllocated+take;
                tx.update(receiptRef,{
                    autoAllocatedQty:nextAllocated,
                    allocationCompleted:nextAllocated>=receiptTarget,
                    allocationUpdatedAt:now
                });
            }
            tx.set(db.collection('inventoryMovements').doc(),inventoryMovementRecord(allocationGuard?'reserve_from_free_stock':'reserve_from_receipt',take,candidate.orderId,productKey,actor,{
                warehouseId,itemId:reservation.itemId||'',fulfillmentType:'WAREHOUSE',
                ownerUid:order.ownerUid||'',salesCode:order.salesCode||'',
                ...(checkpointCollection==='receipts'?{receiptId:receiptId||''}:{transferId:receiptId||''})
            }));
            took=take;
        });
        if(took>0){invalidateWarehouseStockCache(productKey,warehouseId);allocatedQty+=took;remaining-=took;affectedOrderIds.add(candidate.orderId);continue;}
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

async function refreshAffectedOrderCaches(orderIds = []) {
    const ids=[...new Set(orderIds.filter(Boolean))];
    if(!ids.length)return;
    const cacheUid=currentUser?.uid||'',cacheRole=currentUserRole;
    const refreshedOrders=await readDocumentsByIds('orders',ids);
    if(!cacheUid||currentUser?.uid!==cacheUid||currentUserRole!==cacheRole)throw new Error('登入帳號或角色已變更，請重新載入訂單清單。');
    refreshedOrders.forEach(order=>{
        const index=ordersCache.findIndex(row=>row.id===order.id);
        if(index>=0)ordersCache[index]=order;else ordersCache.unshift(order);
        syncOrderIntoPurchasingCaches(order, { render:false });
    });
    ordersCache.sort((a,b)=>(b.orderDate||'').localeCompare(a.orderDate||''));
    writeAppDataCache('orders',ordersCache);
    if (document.getElementById('order-system')?.classList.contains('active')) renderOrdersList();
    if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
}

async function receiveSupplyOrderRecord(supplyId,qty,lotNo='',expiryDate='',operationId='') {
    const now=new Date().toISOString(),actor=deliveryActor();
    const operationKey=String(operationId||'').trim();
    if(!operationKey)throw new Error('缺少到貨操作識別碼，請重新開啟待到貨視窗後再試。');
    let receivedProductKey='',receivedWarehouseId='',sourceOrderId='',sourceOrderStatus='',reservedForSource=0,alreadyProcessed=false,processedReceipt=null;
    const affectedOrderIds = new Set();
    await runRoleTransaction(async tx=>{
        const supplyRef=supplyOrdersCollection().doc(supplyId);
        const receiptRef=db.collection('receipts').doc(operationKey);
        const supplySnap=await tx.get(supplyRef);
        const receiptSnap=await tx.get(receiptRef);
        if(!supplySnap.exists)throw new Error('找不到供應紀錄。');
        const supply=supplySnap.data();
        if(!canConfirmSupplyReceipt(supply))throw new Error('原廠直送由該訂單負責業務確認；倉庫收貨僅限採購、倉管或管理員。');
        if (!globalThis.YushinSupply?.normalize || !globalThis.YushinReceiving?.buildReceiptSnapshot
            || !globalThis.YushinProcurementDemand?.applyReceipt) {
            throw new Error('Supply／Receiving／Procurement Demand core 未載入，無法建立可追溯的到貨紀錄。');
        }
        const demandRef=procurementDemandRef(supply.demandId||'');
        const demandSnap=demandRef?await tx.get(demandRef):null;
        const procurement=globalThis.YushinSupply.normalize({...supply,id:supplyId});
        const updateDemandReceipt=(receiptQty)=>{
            if(!demandRef)return;
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
            receiptDate:localDateString(),
            createdAt:now,
            createdBy:actor,
            ...event
        });
        if (supply.orderId) affectedOrderIds.add(supply.orderId);
        // 已成功提交過的同一 receiptId 必須先走冪等重試；即使之後取消了剩餘未到貨，
        // 也不能把已完成的到貨重試誤判成新的「取消後收貨」。
        if(receiptSnap.exists){
            const receipt=receiptSnap.data()||{};
            if(String(receipt.supplyOrderId||'')!==String(supplyId))throw new Error('到貨操作識別碼衝突，請重新開啟待到貨視窗。');
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
        if(qty<=0||qty>remaining)throw new Error(`本次到貨數量不可超過 ${remaining}。`);
        const directShip=(supply.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP';
        if(directShip){
            if(!supply.orderId||!supply.itemId)throw new Error('原廠直送紀錄缺少來源訂單／品項。');
            const orderRef=db.collection('orders').doc(supply.orderId);
            const orderSnap=await tx.get(orderRef);
            if(!orderSnap.exists)throw new Error('找不到來源訂單。');
            const order=orderSnap.data();
            if(currentUserRole!=='admin'&&order.ownerUid!==currentUser?.uid)throw new Error('只有此訂單負責業務可確認直送到貨。');
            if(normalizedOrderStatus(order)!=='normal')throw new Error('來源訂單已取消，不能繼續確認到貨；請先處理／恢復來源訂單。');
            const items=normalizedOrderItems(order);
            const itemIndex=items.findIndex(item=>item.itemId===supply.itemId);
            if(itemIndex<0)throw new Error('找不到來源訂單品項。');
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
                    {id:operationKey,at:now,date:localDateString(),qty,sourceId:supplyId,by:actor,fulfillmentType:'DIRECT_SHIP'}
                ]
            };
            const deliveryRecord={
                id:`direct-${operationKey}`,receiptId:operationKey,itemId:supply.itemId,itemIndex,date:localDateString(),qty,
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
        const warehouseId=supply.warehouseId||defaultWarehouse()?.id||'';
        if(!warehouseId)throw new Error('此供應紀錄尚未指定入庫倉庫，無法安全入庫。');
        receivedProductKey=productKey;receivedWarehouseId=warehouseId;sourceOrderId=supply.orderId||'';
        const invRef=db.collection('inventory').doc(encodeURIComponent(productKey));
        const whRef=warehouseId?db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,productKey)):null;
        const invSnap=await tx.get(invRef);
        const whSnap=whRef?await tx.get(whRef):null;
        const inv=inventoryNumbers(invSnap.exists?invSnap.data():{});
        const wh=inventoryNumbers(whSnap?.exists?whSnap.data():{});
        let order=null,items=[],itemIndex=-1,reserveQty=0;
        if(supply.orderId){
            const orderRef=db.collection('orders').doc(supply.orderId);
            const reservationRef=db.collection('inventoryReservations').doc(`${supply.orderId}__${supply.itemId}`);
            const orderSnap=await tx.get(orderRef);
            const reservationSnap=await tx.get(reservationRef);
            if(orderSnap.exists){
                order=orderSnap.data();
                sourceOrderStatus=normalizedOrderStatus(order);
                if(sourceOrderStatus!=='normal'&&supply.customerCancellationDisposition!=='KEEP_STOCK')throw new Error('請先由採購確認供應商答覆，保留採購轉庫存後再收貨。');
                // 倉庫型採購即使來源訂單已取消，供應商仍可能照常出貨。
                // 此時貨照常入庫，但不可再占回已取消訂單；整批視為自由庫存。
                items=normalizedOrderItems(order);itemIndex=items.findIndex(item=>item.itemId===supply.itemId);
                if(itemIndex>=0){
                    const item=items[itemIndex];
                    if(sourceOrderStatus==='normal'){
                        if(!reservationSnap.exists)throw new Error('來源訂單缺少庫存預留紀錄，無法安全入庫。');
                        const reservation=reservationSnap.data();
                        const currentReserved=Math.max(0,Number(reservation.quantity||0));
                        const receiptPlan=window.YushinReceiving.applyReceiptToOrderItem({...item,reservedQty:currentReserved},qty);
                        const next=receiptPlan.item;
                        reserveQty=receiptPlan.reservedDelta;
                        reservedForSource=reserveQty;
                        items[itemIndex]={
                            ...next,
                            reservedQty:next.reservedQty,
                            receiptEvents:[
                                ...(item.receiptEvents||[]),
                                {id:operationKey,at:now,date:localDateString(),qty,sourceId:supplyId,by:actor,fulfillmentType:'WAREHOUSE'}
                            ]
                        };
                        const nextOrder={...order,items,itemCount:items.length,orderSchemaVersion:2,updatedAt:now};
                        tx.update(orderRef,{items,itemCount:items.length,orderSchemaVersion:2,...orderWorkIndexFields(nextOrder),updatedAt:now});
                        tx.set(reservationRef,{
                            orderId:supply.orderId,itemId:supply.itemId,orderNo:order.orderNo||order.quoteNo||supply.orderId,
                            productKey,itemCode:supply.itemCode||'',itemName:supply.itemName||'',customerName:order.customerName||'',
                            ownerUid:order.ownerUid||'',salesCode:order.salesCode||'',salesName:order.salesName||'',orderDate:order.orderDate||'',
                            quantity:Number(next.reservedQty||0),shortageQty:Number(next.shortageQty||0),
                            status:Number(next.reservedQty||0)>0?'active':'shortage',warehouseId,updatedAt:now
                        },{merge:true});
                    }else{
                        // 取消中的來源訂單不重新占庫存，但仍同步實際到貨摘要。
                        // 這樣日後恢復訂單時，不會把已經到倉的數量再次誤判成在途採購。
                        const receiptPlan=window.YushinReceiving.applyReceiptToOrderItem({...item,reservedQty:0},qty);
                        items[itemIndex]={
                            ...item,
                            receivedQty:receiptPlan.item.receivedQty,
                            receiptEvents:[
                                ...(item.receiptEvents||[]),
                                {id:operationKey,at:now,date:localDateString(),qty,sourceId:supplyId,by:actor,fulfillmentType:'WAREHOUSE',sourceOrderStatus:'cancelled'}
                            ]
                        };
                        const nextOrder={...order,items,itemCount:items.length,orderSchemaVersion:2,updatedAt:now};
                        tx.update(orderRef,{items,itemCount:items.length,orderSchemaVersion:2,...orderWorkIndexFields(nextOrder),updatedAt:now});
                    }
                }
            }
        }
        const receiptPlan=globalThis.YushinSupply.applyReceipt(procurement,qty);
        const registeredIncoming=Math.max(0,Number(supply.incomingRegisteredQty||0));
        const incomingRelease=receiptPlan.incomingReleaseQty;
        const embeddedLots=[...(invSnap.exists?(invSnap.data().lots||[]):[])];
        const embeddedIndex=embeddedLots.findIndex(l=>(l.lotNo||'')===lotNo&&(l.expiryDate||'')===expiryDate);
        if(embeddedIndex>=0)embeddedLots[embeddedIndex]={...embeddedLots[embeddedIndex],qty:Number(embeddedLots[embeddedIndex].qty||0)+qty};
        else embeddedLots.push({lotNo,expiryDate,qty,receivedAt:now,sourceSupplyId:supplyId});
        {
          const nextInventory={...(invSnap.exists?invSnap.data():{}),productKey,productId:supply.productId||'',itemCode:supply.itemCode||'',itemName:supply.itemName||'',brand:supply.brand||'',onHand:inv.onHand+qty,reserved:inv.reserved+reserveQty,incoming:Math.max(0,inv.incoming-incomingRelease),lots:embeddedLots,updatedAt:now};
          nextInventory.searchTokens=buildInventorySearchTokens(nextInventory);
          tx.set(invRef,nextInventory,{merge:true});
        }
        if(whRef)tx.set(whRef,{warehouseId,productKey,productId:supply.productId||'',itemCode:supply.itemCode||'',itemName:supply.itemName||'',brand:supply.brand||'',onHand:wh.onHand+qty,reserved:wh.reserved+reserveQty,incoming:Math.max(0,wh.incoming-incomingRelease),updatedAt:now},{merge:true});
        const lotRef=db.collection('inventoryLots').doc();
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
                autoAllocationQty,
                autoAllocatedQty:0,
                allocationCompleted:autoAllocationQty===0,
                lotId:lotRef.id,
                lotNo,
                expiryDate
            }
        }));
        tx.set(db.collection('inventoryMovements').doc(),{type:'receipt',qty,productKey,warehouseId,lotNo,expiryDate,sourceType:'SUPPLY_ORDER',sourceId:supplyId,receiptId:operationKey,createdAt:now,createdBy:actor,ownerUid:supply.ownerUid||'',salesCode:supply.salesCode||''});
        updateDemandReceipt(qty);
        tx.update(supplyRef,{
            receivedQty:receiptPlan.record.receivedQty,
            incomingRegisteredQty:receiptPlan.record.incomingRegisteredQty,
            status:receiptPlan.record.status,
            updatedAt:now
        });
    });
    if (receivedProductKey && receivedWarehouseId) invalidateWarehouseStockCache(receivedProductKey, receivedWarehouseId);

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
            const alreadyAllocated=priorMovements
                .filter(row=>row.type==='reserve_from_receipt')
                .reduce((sum,row)=>sum+Math.max(0,Number(row.qty||0)),0);
            let reconciledAllocated=alreadyAllocated;
            await runRoleTransaction(async tx=>{
                const receiptRef=db.collection('receipts').doc(operationKey);
                const receiptSnap=await tx.get(receiptRef);
                if(!receiptSnap.exists)return;
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
            freeQty=Math.max(0,allocationTarget-reconciledAllocated);
        }else{
            freeQty=0;
        }
    }
    if(freeQty>0){
        try{
            const allocation=await allocateFreeReceiptStockToShortages(
                receivedProductKey,receivedWarehouseId,freeQty,actor,sourceOrderId,operationKey
            );
            allocation.affectedOrderIds.forEach(id=>affectedOrderIds.add(id));
        }catch(allocationErr){
            const error=new Error(
                '到貨已完成，但其他缺貨訂單的自動庫存分配尚未完成：'
                +(allocationErr?.message||allocationErr)
                +'。請再按一次「確認到貨」重試；系統不會重複入庫。'
            );
            error.code='receipt-allocation-pending';
            error.receiptCommitted=true;
            error.affectedOrderIds=[...affectedOrderIds];
            throw error;
        }
    }
    return [...affectedOrderIds];
}

window.openSupplyReceipt = function(supplyId) {
    if (receiptTaskBlocksSupply(supplyId)) return;
    const supply = supplyReceivingCache.find(row => row.id === supplyId);
    if (!supply) { alert('找不到這筆待到貨紀錄，請重新整理。'); return; }
    if (!canConfirmSupplyReceipt(supply)) { showActionFeedback('原廠直送請由該訂單負責業務確認到貨。','warning');return; }

    const ordered = Math.max(0, Number(supply.qty || 0));
    const received = Math.max(0, Number(supply.receivedQty || 0));
    const remaining = Math.max(0, ordered - received);
    if (remaining <= 0) { alert('此品項已全部到貨。'); return; }

    const directShip = (supply.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP';
    poReceiptTargetId = `supply:${supply.id}`;
    ensureReceiptOperationId(supply.id);
    const body = document.getElementById('poReceiptBatchBody');
    const title = document.getElementById('poReceiptBatchTitle');
    if (title) title.textContent = directShip
        ? `原廠直送到貨｜${supply.internalNo || supply.id}｜${supply.itemCode || supply.itemName || ''}`
        : `到貨入庫｜${supply.internalNo || supply.id}｜${supply.itemCode || supply.itemName || ''}`;
    body.innerHTML = `
        <tr data-index="0">
            <td><input type="checkbox" class="po-receive-select" checked></td>
            <td>${escapeHtml(supply.itemCode || '')}</td>
            <td>${escapeHtml(supply.itemName || '')}</td>
            <td>${ordered}</td><td>${received}</td><td>${remaining}</td>
            <td><input type="number" class="po-receive-qty" min="0" max="${remaining}" step="any" value="${remaining}" style="width:85px;"></td>
            <td><input type="text" class="po-receive-lot" placeholder="批號" ${directShip ? 'disabled' : ''}></td>
            <td><input type="date" class="po-receive-expiry" ${directShip ? 'disabled' : ''}></td>
        </tr>`;
    document.getElementById('poReceiptBatchOverlay')?.classList.add('active');
};

const receiptTaskJobs = new Map();
const restoredReceiptTaskUsers = new Set();

function receiptTaskKey(supplyId, ownerUid = currentUser?.uid || '') {
    return `${ownerUid}:${supplyId}`;
}
function persistReceiptTasks(ownerUid) {
    try {
        const jobs=[...receiptTaskJobs.values()].filter(job=>job.ownerUid===ownerUid&&job.state!=='done');
        sessionStorage.setItem(`yushin-receipt-tasks:${ownerUid}`,JSON.stringify(jobs));
    } catch(err) { console.warn('無法暫存背景到貨工作，請保持頁面開啟：',err); }
}
function restoreReceiptTasks() {
    const uid=currentUser?.uid;
    if(!uid||restoredReceiptTaskUsers.has(uid))return;
    restoredReceiptTaskUsers.add(uid);
    try {
        const jobs=JSON.parse(sessionStorage.getItem(`yushin-receipt-tasks:${uid}`)||'[]');
        if(Array.isArray(jobs))jobs.forEach(job=>{
            if(job.ownerUid!==uid||typeof job.supplyId!=='string'||!job.supplyId||typeof job.operationBase!=='string'||!job.operationBase||!Array.isArray(job.entries)||!job.entries.length
                ||job.entries.some(entry=>!Number.isFinite(entry.qty)||entry.qty<=0||!Number.isInteger(entry.itemIndex)||entry.itemIndex<0))return;
            const key=receiptTaskKey(job.supplyId,uid);
            if(!receiptTaskJobs.has(key))receiptTaskJobs.set(key,{...job,state:'error',error:'上次處理結果尚未確認；可用原資料重試，系統不會重複入庫。'});
        });
    } catch(err) { console.warn('背景到貨暫存讀取失敗：',err); }
}
function renderReceiptTasks() {
    const panel=document.getElementById('receiptTaskStatus');
    if(!panel)return;
    const jobs=[...receiptTaskJobs.values()].filter(job=>job.ownerUid===currentUser?.uid);
    panel.hidden=!jobs.length;
    panel.innerHTML=jobs.map(job=>`<div class="receipt-task ${job.state==='error'?'receipt-task-error':''}">
        <span>${escapeHtml(job.label)}：${job.state==='error'?escapeHtml(job.error):'到貨處理中，可繼續其他操作；請保持頁面開啟。'}</span>
        ${job.state==='error'&&canReceiveInventoryCapability()?`<button type="button" class="btn-small" onclick="retryReceiptTask(${inlineJsValue(job.supplyId)})">用原資料重試</button>`:''}
    </div>`).join('');
    document.querySelectorAll('button[data-receipt-supply]').forEach(button=>{
        const job=receiptTaskJobs.get(receiptTaskKey(button.dataset.receiptSupply));
        button.disabled=!!job||button.dataset.receiptConfirmed==='true';
        if(job)button.textContent=job.state==='error'?'到貨待確認':'到貨處理中…';
    });
}
function receiptTaskBlocksSupply(supplyId) {
    restoreReceiptTasks();
    const job=receiptTaskJobs.get(receiptTaskKey(supplyId));
    if(!job)return false;
    renderReceiptTasks();
    showActionFeedback(job.state==='error'?'這筆到貨結果待確認，請使用上方「用原資料重試」。':'這筆到貨正在背景處理，其他品項可繼續操作。','warning');
    return true;
}
window.retryReceiptTask = function(supplyId) {
    if(!canReceiveInventoryCapability())return;
    const job=receiptTaskJobs.get(receiptTaskKey(supplyId));
    if(!job||job.state!=='error')return;
    return runReceiptTask(job);
};
window.addEventListener('beforeunload',event=>{
    if([...receiptTaskJobs.values()].some(job=>job.state==='running')){
        event.preventDefault();event.returnValue='';
    }
});

async function refreshReceiptTaskViews(affectedOrderIds) {
    markMainPageDirty('inventory','orders.list','orders.po','admin');
    const refreshes=[];
    // 已開始的查詢可能早於這次到貨；等它結束後再讀最新資料，避免合併成過期的刷新。
    const pendingReads=[purchasingReceivingLoadPromise,activeReceivingSupplyLoadPromise].filter(Boolean);
    if(pendingReads.length)await Promise.allSettled(pendingReads);
    if(inventoryReceivingVisible&&document.getElementById('inventory-system')?.classList.contains('active'))refreshes.push(loadPurchasingReceivingQueue(true));
    else if(canAccessPage('inventory')&&document.getElementById('inventory-system')?.classList.contains('active'))refreshes.push(loadInventory(true));
    if(getDataScope('orders')!=='none')refreshes.push(refreshAffectedOrderCaches([...affectedOrderIds]));
    const results=await Promise.allSettled(refreshes);
    if(results.some(result=>result.status==='rejected'))showActionFeedback('到貨已完成；部分畫面同步失敗，重新進入該頁會再載入。','warning');
}

async function runReceiptTask(job) {
    if(job.state==='running'||job.ownerUid!==currentUser?.uid||(!canReceiveInventoryCapability()&&!['sales','engineer'].includes(currentUserRole)))return;
    job.state='running';job.error='';
    persistReceiptTasks(job.ownerUid);
    renderReceiptTasks();
    const affectedOrderIds=new Set();
    const supplyId=job.supplyId;
    try {
        for(const entry of job.entries){
            if(currentUser?.uid!==job.ownerUid||(!canReceiveInventoryCapability()&&!['sales','engineer'].includes(currentUserRole)))throw new Error('登入身份已變更，請以原帳號確認到貨結果。');
            const operationId=`${job.operationBase}-${entry.itemIndex}`;
            const ids=await receiveSupplyOrderRecord(supplyId,entry.qty,entry.lotNo,entry.expiryDate,operationId);
            ids.forEach(id=>affectedOrderIds.add(id));
        }
        // 核心資料已確認完成後才移除暫存。保留同一個 operationId 供網路中斷重試。
        clearReceiptOperationId(supplyId,job.operationBase,job.ownerUid);
        job.state='done';
        receiptTaskJobs.delete(receiptTaskKey(supplyId,job.ownerUid));
        persistReceiptTasks(job.ownerUid);
        if(currentUser?.uid!==job.ownerUid)return;
        // 暫時移除這筆舊到貨列；部分到貨餘額由後續查詢帶回，不用舊快取推算數量。
        supplyReceivingCache=supplyReceivingCache.filter(row=>row.id!==supplyId);
        pendingSupplyCache=pendingSupplyCache.filter(row=>row.id!==supplyId);
        document.querySelectorAll('button[data-receipt-supply]').forEach(button=>{
            if(button.dataset.receiptSupply===supplyId){button.dataset.receiptConfirmed='true';button.disabled=true;button.textContent='到貨已確認';}
        });
        renderReceiptTasks();
        showActionFeedback(`${job.label}：到貨已確認。`,'success');
        await refreshReceiptTaskViews(affectedOrderIds);
    } catch(err) {
        if(job.state==='done'){
            if(currentUser?.uid===job.ownerUid)showActionFeedback('到貨已確認；畫面同步失敗，重新進入該頁會再載入。','warning');
            return;
        }
        // 後續分配可能尚未完成；原收貨資料與識別碼必須保留，不能換成新的一筆。
        job.state='error';
        job.error=err?.code==='receipt-allocation-pending'&&err?.receiptCommitted
            ? '已入庫，庫存分配尚未完成。請用原資料重試。'
            : `結果待確認：${err.message||err}。請用原資料重試。`;
        persistReceiptTasks(job.ownerUid);
        if(currentUser?.uid===job.ownerUid)renderReceiptTasks();
    }
}

window.savePoReceiptBatch = async function() {
    const poId=poReceiptTargetId;
    if(!poId?.startsWith('supply:')){alert('到貨必須從供應紀錄進入，請重新開啟待到貨品項。');return;}
    const supplyId=poId.slice(7);
    if(receiptTaskBlocksSupply(supplyId))return;
    const rows=[...document.querySelectorAll('#poReceiptBatchBody tr')].filter(row=>row.querySelector('.po-receive-select')?.checked);
    const entries=rows.map(row=>({itemIndex:Number(row.dataset.index),qty:Number(row.querySelector('.po-receive-qty')?.value||0),
        lotNo:(row.querySelector('.po-receive-lot')?.value||'').trim(),expiryDate:row.querySelector('.po-receive-expiry')?.value||''}));
    if(!entries.length||entries.some((entry,index)=>!Number.isFinite(entry.qty)||entry.qty<=0||entry.qty>Number(rows[index].querySelector('.po-receive-qty')?.max)||!Number.isInteger(entry.itemIndex))){
        alert('請勾選到貨品項，數量須大於 0 且不可超過未收數量。');return;
    }
    const operationBase=poReceiptOperationId||ensureReceiptOperationId(supplyId);
    const supply=supplyReceivingCache.find(row=>row.id===supplyId)||pendingSupplyCache.find(row=>row.id===supplyId);
    if(!supply||!canConfirmSupplyReceipt(supply)){showActionFeedback('目前沒有這筆到貨確認權限，請重新開啟訂單。','warning');return;}
    const job={supplyId,operationBase,entries,ownerUid:currentUser.uid,label:supply?.itemCode||supply?.itemName||supplyId,state:'queued',error:''};
    receiptTaskJobs.set(receiptTaskKey(supplyId),job);
    persistReceiptTasks(job.ownerUid);
    // 關閉視窗前先保存獨立快照；後續開啟另一筆不會覆寫這筆的數量、批號或識別碼。
    closePoReceiptBatch();
    showActionFeedback('已開始背景確認到貨，可繼續其他操作；請保持頁面開啟。');
    return runReceiptTask(job);
};

function purchaseItemsFromSavedPo(po) {
    const sourceItems = [po?.items, po?.orderItems, po?.purchaseItems, po?.lineItems, po?.products]
        .find(items => Array.isArray(items) && items.length)
        || ((po?.itemName || po?.productName || po?.itemCode || po?.productCode) ? [po] : []);
    return sourceItems.map((item, index) => ({
        ...item,
        orderId: item.orderId || item.sourceOrderId || '',
        orderItemIndex: item.orderItemIndex ?? index,
        itemName: item.itemName || item.productName || item.name || item.nameCn || '',
        itemCode: item.itemCode || item.productCode || item.code || item.model || '',
        productId: item.productId || '',
        brand: item.brand || item.manufacturer || '',
        brandId: item.brandId || '',
        qty: parseFloat(item.qty ?? item.quantity ?? item.count) || 1,
        unitPrice: parseFloat(item.unitPrice ?? item.costPrice ?? item.cost ?? item.purchasePrice) || 0
    })).filter(item => item.itemName || item.itemCode);
}

// 將不同時期的訂單品項格式統一成採購單使用的格式。舊資料是一張訂單一個
// itemName/itemCode/qty；新版或匯入資料可能使用 items、orderItems 或 products。
// 只在讀取時轉換，不回寫原訂單，避免 Phase 1 變成資料模型遷移。
function purchaseItemsFromOrder(order) {
    const collections = [order?.items, order?.orderItems, order?.lineItems, order?.products];
    const sourceItems = collections.find(items => Array.isArray(items) && items.length) || [order || {}];
    return sourceItems.map((item, index) => {
        const itemCode = item.itemCode || item.productCode || item.code || item.model || order.itemCode || order.productCode || '';
        const itemName = item.itemName || item.productName || item.name || item.nameCn || order.itemName || order.productName || '';
        const brand = item.brand || item.manufacturer || order.brand || '';
        const qtyValue = item.qty ?? item.quantity ?? item.count ?? (sourceItems.length === 1 ? order.qty ?? order.quantity : 1);
        let cost = parseFloat(item.costPrice ?? item.cost ?? item.purchasePrice ?? (sourceItems.length === 1 ? order.costPrice : NaN));
        {
            const savedProductId = item.productId || order.productId || '';
            const normalizedCode = normalizeItemCode(itemCode);
            const normalizedBrand = String(brand || '').trim().toLocaleLowerCase();
            const priceMatch = (savedProductId && priceList.find(product => product.productId === savedProductId))
                || (normalizedBrand && priceItemLookup.get(`brand:${normalizedBrand}:${normalizedCode}`))
                || priceItemLookup.get(`code:${normalizedCode}`);
            const productId = savedProductId || priceMatch?.productId || (priceMatch ? stableProductId(priceMatch) : '');
            const secureCost = productId ? purchaseCostCache.get(productId) : null;
            if (secureCost !== undefined && secureCost !== null) cost = Number(secureCost);
            else if ((!Number.isFinite(cost) || cost < 0) && priceMatch) {
                cost = parseFloat(priceMatch.cost ?? priceMatch.costPrice ?? priceMatch.purchasePrice);
            }
        }
        const parsedQty=parseFloat(qtyValue);
        const fullQty=Number.isFinite(parsedQty)&&parsedQty>0?parsedQty:1;
        const procurementType=item.procurementType||order.procurementType||'PURCHASING_PO';
        if(procurementType==='SALES_SELF_ORDER') return null;
        // 待採購數量必須與採購頁、訂單工作狀態共用同一公式。
        // shortageQty 會在到貨時下降，不能再直接減累計 supplyOrderedQty，
        // 否則「部分採購已全部到貨、但仍有剩餘缺口」會被誤算成 0。
        const remainingPurchase=remainingProcurementQty(order,item);
        return {
            orderId: order.id,
            orderItemIndex: index,
            itemId:item.itemId||`item-${index+1}`,
            itemName,
            itemCode,
            productId: item.productId || order.productId || '',
            brand,
            brandId: item.brandId || order.brandId || '',
            qty: remainingPurchase,
            productLine: item.productLine || order.productLine || '',
            ownerUid: order.ownerUid || '',
            salesCode: order.salesCode || '',
            salesName: order.salesName || '',
            fulfillmentType: item.fulfillmentType || order.fulfillmentType || 'WAREHOUSE',
            warehouseId: item.warehouseId || order.warehouseId || '',
            unitPrice: Number.isFinite(cost) && cost >= 0 ? cost : null,
            procurementType
        };
    }).filter(item => item && (item.itemName || item.itemCode) && Number(item.qty||0)>0);
}

function bestPurchaseOrderCompany(selectedOrders, items, preferredCompany) {
    const companies = ['yushin', 'morningstar', 'MULTI-LIFE'];
    const savedCompanies = [...new Set(selectedOrders.map(order => order.company).filter(company => companies.includes(company)))];
    if (savedCompanies.length === 1 && items.some(item => isCompanyBrandAllowed(savedCompanies[0], item.brand))) return savedCompanies[0];
    if (companies.includes(preferredCompany) && items.some(item => isCompanyBrandAllowed(preferredCompany, item.brand))) return preferredCompany;
    return companies
        .map(company => ({ company, count: items.filter(item => isCompanyBrandAllowed(company, item.brand)).length }))
        .sort((a, b) => b.count - a.count)[0]?.company || 'yushin';
}

async function openProductManagementProductsInPurchase(products) {
    if (!canEditPage('orders.po') || !products.length) return false;
    const button = actionButtonFromEventOrSelector();
    const state = beginActionButton(button, '載入採購品項…');
    if (button && !state) return false;
    try {
        // Refresh only selected products; never trust a stale selection or scan all costs.
        const refreshed = await Promise.all(products.map(async selected => {
            const id = selected.productId || selected.id;
            const [productSnap, costSnap] = await Promise.all([
                firestoreReadWithTimeout(db.collection('products').doc(id).get(), '讀取採購產品'),
                firestoreReadWithTimeout(db.collection('productCosts').doc(id).get(), '讀取標準成本')
            ]);
            if (!productSnap.exists || productSnap.data().active === false || productSnap.data().status === 'INACTIVE') {
                throw new Error('所選產品已停用或不存在，請重新選取。');
            }
            const costValue = costSnap.exists ? costSnap.data().standardCost ?? costSnap.data().costPrice : null;
            const cost = costValue === null || costValue === undefined ? NaN : Number(costValue);
            return { ...productSnap.data(), productId:id, purchaseCost:Number.isFinite(cost) && cost >= 0 ? cost : null };
        }));
        // The modal opens synchronously before warehouse suggestions finish loading.
        const opening = openDirectStockPurchase(refreshed[0]);
        poItems = refreshed.map(product => ({ ...emptyDirectPoItem(),
            ...productManagementSource(product), unitPrice:product.purchaseCost }));
        poAllItems = poItems;
        renderPoItemsTable();
        updatePoModeUI();
        await opening;
        return true;
    } catch (err) {
        showActionFeedback('加入採購單失敗：' + err.message, 'warning');
        return false;
    } finally { endActionButton(button, state); }
}

window.addProductManagementToPurchase = async function(productId) {
    await openProductManagementProductsInPurchase([{ productId }]);
};

window.addProductManagementSelectionToPurchase = async function() {
    const products = selectedProductManagementProducts();
    if (await openProductManagementProductsInPurchase(products)) clearProductManagementSelection();
};

window.openDirectStockPurchase = async function(product = null) {
    if (!canEditPage('orders.po')) return;
    const openingGeneration = ++poDirectStockOpenGeneration;
    poDirectStockMode = true;
    poEditingId = null;
    poIncomingSyncPending = false;
    poAllItems = [];
    poItems = [];
    document.getElementById('poVendorName').value = '';
    document.getElementById('poBuyerName').innerText = currentUserName || (currentUser ? currentUser.email : '');
    document.getElementById('poDate').value = localDateString();
    clearPoExpectedDate();
    switchPoCompany(currentCompany || 'yushin', null, true);
    generatePoNo();
    addDirectPoItem();
    if(product){
        poItems[0]={...poItems[0],productId:product.productId||product.id,
            itemCode:product.manufacturerPartNo||product.sku||product.model||'',
            itemName:product.productName||product.nameCn||product.nameEn||'',
            brand:resolveBrandName(product.brandName||product.brand||''),
            brandId:product.brandId||'',productLine:product.productLine||'',productType:product.productType||'',
            unitPrice:null};
        renderPoItemsTable();
    }
    updatePoModeUI();
    updatePoSaveStatus('這張採購單尚未建立。確認品項、供應商與單價後，按「建立採購單並下載 PDF」；建立成功後自動列入待到貨。');
    document.getElementById('poModalOverlay').classList.add('active');

    // 備貨單的空白表單不依賴雲端主檔，先立即顯示；供應商與預設倉庫在背景補齊。
    // 不重畫使用者已經開始輸入的表格，避免慢網路回來時洗掉尚未觸發 change 的文字。
    await loadSupplierWarehouseMasters();
    if (openingGeneration !== poDirectStockOpenGeneration || !poDirectStockMode || poEditingId) return;
    const warehouseId = defaultWarehouse()?.id || '';
    poItems.forEach(item => {
        if (!item.warehouseId) item.warehouseId = warehouseId;
    });
    populatePoVendorSuggestions();
    updatePoModeUI();
};

function emptyDirectPoItem() {
    return {
        orderId:'', sourceType:'STOCK_REPLENISHMENT', sourceId:'',
        itemName:'', itemCode:'', productId:'', brand:'', brandId:'', qty:1, unitPrice:null, supplier:'',
        productLine:'', fulfillmentType:'WAREHOUSE', warehouseId:defaultWarehouse()?.id || ''
    };
}

window.addDirectPoItem = function() {
    poDirectStockMode = true;
    poItems.push(emptyDirectPoItem());
    poAllItems = poItems;
    window.autoFillPoExpectedDate(poItems);
    renderPoItemsTable();
    updatePoModeUI();
};

window.onDirectPoCodeChange = async function(idx, value) {
    if (!poItems[idx]) return;
    const requestedCode = String(value || '').trim();
    const preferredBrand = resolveBrandName(poItems[idx].brand || '');
    poItems[idx] = {
        ...poItems[idx],
        itemCode: requestedCode,
        itemName: '',
        productId: '',
        brand: preferredBrand,
        brandId: brandIdForName(preferredBrand),
        unitPrice: null,
        supplier: '',
        productLine: ''
    };
    poAllItems = poItems;
    const match = requestedCode ? await findProductByCode(requestedCode, preferredBrand) : null;
    if (!poItems[idx] || String(poItems[idx].itemCode || '').trim() !== requestedCode) return;
    if (match) {
        const secureCost = await loadVisibleProductCost(match);
        if (!poItems[idx] || String(poItems[idx].itemCode || '').trim() !== requestedCode) return;
        poItems[idx] = {
            ...poItems[idx],
            itemCode: match.model || requestedCode,
            itemName: match.nameCn || match.nameEn || '',
            productId: match.productId || stableProductId(match),
            brand: resolveBrandName(match.brand || ''),
            brandId: match.brandId || brandIdForName(match.brand || ''),
            unitPrice: secureCost !== null && Number.isFinite(secureCost)
                ? secureCost
                : match.cost !== null && match.cost !== undefined && match.cost !== '' && Number.isFinite(Number(match.cost)) ? Number(match.cost) : null,
            supplier: match.supplier || '',
            productLine: match.productLine || '',
            fulfillmentType: poItems[idx].fulfillmentType || 'WAREHOUSE',
            warehouseId: poItems[idx].warehouseId || defaultWarehouse()?.id || ''
        };
        const mappedSupplier = supplierForProduct(
            match.brand,
            match.productLine,
            match.productId || stableProductId(match),
            match.model || requestedCode
        );
        if (!document.getElementById('poVendorName').value && mappedSupplier) {
            document.getElementById('poVendorName').value = mappedSupplier.purchaseHeaderName || mappedSupplier.supplierName || '';
        } else if (!document.getElementById('poVendorName').value && match.supplier) {
            document.getElementById('poVendorName').value = match.supplier;
        }
    }
    poAllItems = poItems;
    window.autoFillPoExpectedDate(poItems);
    renderPoItemsTable();
};

window.updateDirectPoText = function(idx, field, value) {
    if (!poItems[idx]) return;
    poItems[idx][field] = field === 'brand' ? resolveBrandName(value) : String(value || '').trim();
    if (field === 'brand') {
        poItems[idx].brandId = brandIdForName(poItems[idx].brand);
        if (poItems[idx].itemCode) {
            onDirectPoCodeChange(idx, poItems[idx].itemCode);
            return;
        }
    }
    poAllItems = poItems;
    window.autoFillPoExpectedDate(poItems);
};

function updatePoModeUI() {
    const leadDays=document.getElementById('poLeadDays');
    if(leadDays)leadDays.disabled=!!poEditingId;
    const addBtn = document.getElementById('poAddStockItemBtn');
    const hint = document.getElementById('poModeHint');
    const brandList = document.getElementById('poBrandList');
    const overlay = document.getElementById('poModalOverlay');
    const title = document.getElementById('poModalTitle');
    const existingBanner = document.getElementById('poExistingBanner');
    const existingNumber = document.getElementById('poExistingNumber');
    const copyBtn = document.getElementById('poCopyAsNewBtn');
    if (brandList) brandList.innerHTML = getUnifiedBrandNames(false).map(name => `<option value="${escapeAttr(name)}"></option>`).join('');

    const viewingExisting = !!poEditingId;
    overlay?.classList.toggle('po-viewing-existing', viewingExisting);
    if (title) title.textContent = viewingExisting ? '查看採購單' : '建立採購單';
    if (existingBanner) existingBanner.style.display = viewingExisting ? 'flex' : 'none';
    if (existingNumber) existingNumber.textContent = viewingExisting ? (document.getElementById('poNo')?.innerText || poEditingId) : '';

    const savedPo = viewingExisting ? poListCache.find(po => po.id === poEditingId) : null;
    const canCopySafely = !!savedPo && canCreatePurchaseOrderCapability() && canEditPage('orders.po');
    if (copyBtn) { copyBtn.style.display = canCopySafely ? '' : 'none'; copyBtn.disabled = poSaveInProgress; }
    const timelineBtn = document.getElementById('poViewHistoryBtn');
    if (timelineBtn) timelineBtn.style.display = viewingExisting ? '' : 'none';
    const cancelBtn = document.getElementById('poCancelOutstandingBtn');
    const hasOutstanding = !!savedPo && !isPurchaseTerminalStatus(savedPo.status) && purchaseItemsFromSavedPo(savedPo).some((_, index) => Number(purchaseHistoryItemReceiptProgress(savedPo, index).remainingQty) > 0);
    if (cancelBtn) cancelBtn.style.display = canCopySafely && hasOutstanding ? '' : 'none';
    const supplierContact = savedPo ? purchaseOrderSupplierContact(savedPo) : purchaseOrderSupplierContact({vendorName:document.getElementById('poVendorName')?.value||''});

    if (addBtn) addBtn.style.display = !viewingExisting && poDirectStockMode ? '' : 'none';
    if (hint) hint.textContent = viewingExisting
        ? '這是已建立的正式採購單。內容鎖定不直接修改；可重新匯出 PDF。'
        : poDirectStockMode
            ? '建立庫存採購採購單：可一次加入多個品項；建立後會列入在途庫存。'
            : '訂單採購：品項來自業務訂單，可調整採購數量與進貨單價。';
    updatePoSaveButton();
}


function clearPoExpectedDate() {
    const days=document.getElementById('poLeadDays');
    if(days)days.value='';
    const input=document.getElementById('poExpectedDate');
    if(!input)return;
    input.value='';
    delete input.dataset.expectedDateSource;
    syncPoLeadDays();
}

window.markPoExpectedDateManual = function() {
    const input=document.getElementById('poExpectedDate');
    if(input)input.dataset.expectedDateSource='manual';
};

window.autoFillPoExpectedDate = function(items = poItems, preferredSupplierId = '') {
    const input=document.getElementById('poExpectedDate');
    if(!input || poEditingId)return input?.value||'';
    if(input.dataset.expectedDateSource==='manual') {
        if(document.getElementById('poLeadDays')?.value!=='')window.setPoLeadDays();
        return input.value||'';
    }
    if(!globalThis.YushinSupplier?.purchaseExpectedDate)return '';

    const vendorName=String(document.getElementById('poVendorName')?.value||'').trim();
    const liveSupplier=supplierForVendorName(vendorName);
    const supplierId=String(preferredSupplierId||liveSupplier?.id||liveSupplier?.supplierId||'').trim();
    const supplier=supplierMasterCache.find(item =>
        String(item.id||item.supplierId||'')===supplierId
    )||liveSupplier||null;
    const orderDate=String(document.getElementById('poDate')?.value||'').trim();
    const expected=globalThis.YushinSupplier.purchaseExpectedDate(
        items||[],
        supplier||0,
        orderDate
    );

    if(expected){
        input.value=expected;
        input.dataset.expectedDateSource='lead-time';
    }else if(input.dataset.expectedDateSource==='lead-time'){
        input.value='';
        delete input.dataset.expectedDateSource;
    }
    syncPoLeadDays();
    return expected;
};

function syncPoLeadDays() {
    const days=document.getElementById('poLeadDays');
    const date=document.getElementById('poExpectedDate')?.value;
    const ordered=document.getElementById('poDate')?.value;
    if(days)days.value=date&&ordered?Math.max(0,(Date.parse(date)-Date.parse(ordered))/86400000):'';
    const hint=document.getElementById('poExpectedDateHint');
    if(hint)hint.textContent=date?`預計 ${date} 到貨`:'未設定交期';
}

window.setPoLeadDays = function() {
    if(poEditingId)return;
    const days=document.getElementById('poLeadDays');
    const date=document.getElementById('poExpectedDate');
    const ordered=document.getElementById('poDate')?.value;
    if(!days||!date)return;
    const value=Number(days.value);
    if(days.value===''||!ordered){date.value='';delete date.dataset.expectedDateSource;}
    else if(Number.isInteger(value)&&value>=0){
        const expected=new Date(ordered+'T00:00:00Z');
        expected.setUTCDate(expected.getUTCDate()+value);
        date.value=expected.toISOString().slice(0,10);
        date.dataset.expectedDateSource='manual';
    }else{
        date.value='';delete date.dataset.expectedDateSource;
        const hint=document.getElementById('poExpectedDateHint');
        if(hint)hint.textContent='請輸入 0 或以上的整數天數';
        return;
    }
    const hint=document.getElementById('poExpectedDateHint');
    if(hint)hint.textContent=date.value?`預計 ${date.value} 到貨`:'未設定交期';
};

function poItemsWithScheduleDates(items = [], supplierId = '', orderDate = '', headerExpectedDate = '', expectedDateSource = '') {
    const manualHeader = expectedDateSource === 'manual'
        || (!!headerExpectedDate && expectedDateSource !== 'lead-time');
    const supplier=supplierMasterCache.find(item =>
        String(item.id||item.supplierId||'')===String(supplierId||'')
    )||null;
    return (items || []).map(item => {
        let scheduleDate = '';
        if (manualHeader) {
            scheduleDate = headerExpectedDate || '';
        } else if (supplier && globalThis.YushinSupplier?.itemExpectedArrivalDate) {
            scheduleDate = globalThis.YushinSupplier.itemExpectedArrivalDate(item,supplier,orderDate);
        }
        return { ...item, scheduleDate };
    });
}

async function autoFillPoSupplier(items) {
    await loadSupplierWarehouseMasters();
    const rows=items||[];
    const resolved = rows.map(item => supplierForProduct(
        item.brand,
        item.productLine,
        item.productId,
        item.itemCode
    )).filter(Boolean);
    if (!resolved.length) {
        window.autoFillPoExpectedDate(rows,'__unresolved__');
        return '';
    }
    const ids = [...new Set(resolved.map(item => item.id || item.supplierId))];
    if (ids.length !== 1) {
        window.autoFillPoExpectedDate(rows,'__multiple__');
        return '';
    }
    const supplier = resolved[0];
    const header = supplier.purchaseHeaderName || supplier.supplierName || '';
    const input = document.getElementById('poVendorName');
    if (input && header) input.value = header;
    window.autoFillPoExpectedDate(rows,ids[0]);
    return header;
}

function populatePoVendorSuggestions() {
    const list = document.getElementById('poVendorSuggestions');
    if (!list) return;
    const vendorsByKey = new Map();
    const addVendor = name => {
        const value=String(name||'').trim();
        if(!value)return;
        const key=value.normalize('NFKC').replace(/\s+/g,' ').toLocaleLowerCase();
        if(!vendorsByKey.has(key))vendorsByKey.set(key,value);
    };
    supplierMasterCache.forEach(supplier=>addVendor(supplier.purchaseHeaderName||supplier.supplierName));
    poListCache.forEach(po=>addVendor(po.vendorName));
    list.innerHTML = '';
    [...vendorsByKey.values()]
        .sort((a, b) => a.localeCompare(b, 'zh-Hant'))
        .forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            list.appendChild(option);
        });
}

window.closePurchaseOrderModal = function() {
    poDirectStockOpenGeneration++;
    poNoGeneration++;
    poNoLoading = false;
    poNoReady = false;
    document.getElementById('poModalOverlay').classList.remove('active');
};

// 切換採購單要用哪間公司的抬頭／單號代碼（又鑫 YS／辰星 MS／鼎新 DS），跟估價單的公司切換邏輯一致
window.switchPoCompany = function(compKey, el, skipNoGen) {
    poCurrentCompany = compKey;
    document.querySelectorAll('#poModalOverlay .sub-nav .sub-tab').forEach(t => t.classList.remove('active'));
    const targetTab = document.getElementById(`po-sub-${compKey}`);
    if (targetTab) targetTab.classList.add('active');
    else if (el) el.classList.add('active');

    const info = companyData[compKey];
    if (info) {
        document.getElementById('poCompTitle').innerText = info.title;
        document.getElementById('poCompSub').innerText = info.sub;
        document.getElementById('poCompAddr').innerText = info.addr;
        document.getElementById('poCompContact').innerHTML = info.contact;
    }

    // 依管理員設定，採購單只帶入該分公司代理的廠牌；切換分公司時立即重新篩選。
    if (!skipNoGen && poAllItems.length) {
        poItems = poAllItems.filter(item => isCompanyBrandAllowed(compKey, item.brand));
        renderPoItemsTable();
    }

    // 重新列印「採購訂單」裡舊有的採購單時，要沿用當初存的單號，不能在這裡重新產生一個新的
    if (!skipNoGen) generatePoNo();
};

// 採購單號格式：PO-{公司代碼}-{日期}-{採購代號}-{流水號}，跟估價單單號的組成方式一致，
// 例如又鑫、代號 03 的採購，會是 PO-YS-20260824-03-01。
// 流水號是真的依照雲端已經產生過幾張採購單去算「目前最大流水號 + 1」，不是隨機亂數，
// 邏輯跟估價單的 generateQuoteNo 一致，這樣才能保證同一天同一間公司不會撞號
window.generatePoNo = async function() {
    const info = companyData[poCurrentCompany];
    if (!info) return '';
    const generation = ++poNoGeneration;
    const dateStr = getFormattedDateCode();
    const purchaserCode = currentUserCode || '01';
    const prefix = `PO-${info.prefix}-${dateStr}-${purchaserCode}-`;
    const numberEl = document.getElementById('poNo');

    poNoReady = false;
    poNoLoading = true;
    if (numberEl) numberEl.innerText = '產生中…';
    updatePoSaveButton();

    try {
        const snapshot = await firestoreReadWithTimeout(
            db.collection('purchaseOrders')
                .where('poNo', '>=', prefix)
                .where('poNo', '<=', prefix + '\uf8ff')
                .orderBy('poNo', 'desc')
                .limit(1)
                .get(),
            '採購單號'
        );

        // 使用者可能在查詢尚未回來時切換公司、關閉視窗或開啟另一張單。
        // 舊查詢結果不得再覆蓋目前畫面。
        if (generation !== poNoGeneration) return '';

        let maxSeq = 0;
        snapshot.forEach(doc => {
            const seqStr = (doc.data().poNo || '').split('-').pop();
            const seq = parseInt(seqStr, 10);
            if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
        });
        const nextNo = `${prefix}${String(maxSeq + 1).padStart(2, '0')}`;
        if (numberEl) numberEl.innerText = nextNo;
        poNoReady = true;
        return nextNo;
    } catch (e) {
        if (generation !== poNoGeneration) return '';
        // 查不到目前最大流水號時不能直接假設 01；那可能撞到已存在的正式 PO。
        if (numberEl) numberEl.innerText = '—';
        poNoReady = false;
        updatePoSaveStatus('採購單號讀取失敗，請切換公司或重新開啟後再試。', true);
        return '';
    } finally {
        if (generation === poNoGeneration) {
            poNoLoading = false;
            updatePoSaveButton();
        }
    }
};

function renderPoItemsTable() {
    const tbody = document.getElementById('poItemsBody');
    tbody.innerHTML = '';
    poItems.forEach((item, idx) => {
        const missingPrice = item.unitPrice === null || item.unitPrice === undefined || item.unitPrice === '' || !Number.isFinite(Number(item.unitPrice)) || Number(item.unitPrice) < 0;
        const tr = document.createElement('tr');
        if (poDirectStockMode) {
            tr.innerHTML = `
                <td style="border:1px solid #999;padding:4px;"><input type="text" value="${escapeAttr(item.itemName||'')}" placeholder="品名" style="width:100%;box-sizing:border-box;" onchange="updateDirectPoText(${idx},'itemName',this.value)"></td>
                <td style="border:1px solid #999;padding:4px;"><input type="text" list="priceModelList" value="${escapeAttr(item.itemCode||'')}" placeholder="貨號" style="width:100%;box-sizing:border-box;" onchange="onDirectPoCodeChange(${idx},this.value)"></td>
                <td style="border:1px solid #999;padding:4px;"><input type="text" list="poBrandList" value="${escapeAttr(item.brand||'')}" placeholder="廠牌" style="width:100%;box-sizing:border-box;" onchange="updateDirectPoText(${idx},'brand',this.value)"></td>
                <td style="border:1px solid #999;padding:4px;"><input type="number" min="0.0001" step="any" value="${item.qty||1}" style="width:100%;box-sizing:border-box;" onchange="updatePoItem(${idx},'qty',this.value)"></td>
                <td style="border:1px solid #999;padding:4px;"><input type="number" min="0" step="0.01" value="${missingPrice?'':item.unitPrice}" placeholder="未稅進貨單價" class="${missingPrice?'po-missing-price':''}" style="width:100%;box-sizing:border-box;" onchange="updatePoItem(${idx},'unitPrice',this.value)"></td>
                <td style="border:1px solid #999;padding:4px;text-align:right;">${(Number(item.qty||0)*Number(item.unitPrice||0)).toFixed(0)}</td>
                <td class="no-print" style="border:1px solid #999;padding:4px;text-align:center;"><button type="button" class="btn-small btn-danger" onclick="removePoItem(${idx})">刪除</button></td>
            `;
        } else {
            tr.innerHTML = `
                <td style="border:1px solid #999;padding:4px;"><input type="text" value="${escapeAttr(item.itemName||'')}" placeholder="品名" style="width:100%;box-sizing:border-box;" onchange="updateDirectPoText(${idx},'itemName',this.value)"></td>
                <td style="border:1px solid #999;padding:4px;"><input type="text" list="priceModelList" value="${escapeAttr(item.itemCode||'')}" placeholder="貨號" style="width:100%;box-sizing:border-box;" onchange="onDirectPoCodeChange(${idx},this.value)"></td>
                <td style="border:1px solid #999;padding:4px;"><input type="text" list="poBrandList" value="${escapeAttr(item.brand||'')}" placeholder="廠牌" style="width:100%;box-sizing:border-box;" onchange="updateDirectPoText(${idx},'brand',this.value)"></td>
                <td style="border:1px solid #999;padding:4px;"><input type="number" step="1" value="${item.qty}" style="width:100%;box-sizing:border-box;" onchange="updatePoItem(${idx}, 'qty', this.value)"></td>
                <td style="border:1px solid #999;padding:4px;"><input type="number" min="0.01" step="0.01" value="${missingPrice ? '' : item.unitPrice}" placeholder="請填進貨單價" class="${missingPrice ? 'po-missing-price' : ''}" style="width:100%;box-sizing:border-box;" onchange="updatePoItem(${idx}, 'unitPrice', this.value)">${missingPrice ? '<small class="po-missing-price-hint">缺少成本</small>' : ''}</td>
                <td style="border:1px solid #999;padding:4px;text-align:right;">${(item.qty * item.unitPrice).toFixed(0)}</td>
                <td class="no-print" style="border:1px solid #999;padding:4px;text-align:center;"><button type="button" class="btn-small btn-danger" onclick="removePoItem(${idx})">刪除</button></td>
            `;
        }
        tbody.appendChild(tr);
    });
    recalcPoTotals();
}

window.updatePoItem = function(idx, field, value) {
    if (!poItems[idx]) return;
    poItems[idx][field] = field === 'unitPrice' && String(value).trim() === '' ? null : parseFloat(value);
    renderPoItemsTable();
};

window.removePoItem = function(idx) {
    const removed = poItems[idx];
    poItems.splice(idx, 1);
    poAllItems = poAllItems.filter(item => item !== removed);
    window.autoFillPoExpectedDate(poItems);
    renderPoItemsTable();
};

function recalcPoTotals() {
    const subtotal = poItems.reduce((sum, item) => sum + (item.qty * item.unitPrice), 0);
    const tax = Math.round(subtotal * 0.05);
    const grandTotal = Math.round(subtotal) + tax;
    document.getElementById('poSubtotal').innerText = Math.round(subtotal).toLocaleString();
    document.getElementById('poTax').innerText = tax.toLocaleString();
    document.getElementById('poGrandTotal').innerText = grandTotal.toLocaleString();
}

function formalSupplyOrderId(purchaseOrderId, itemIndex) {
    return `po-${encodeURIComponent(String(purchaseOrderId||''))}-${Number(itemIndex||0)}`;
}

function assertPurchaseLinesAvailable(order, lines) {
    if(orderInventorySyncIncomplete(order))throw new Error('來源訂單庫存尚未同步完成，請稍後再採購。');
    if (normalizedOrderStatus(order) !== 'normal') throw new Error('來源訂單已取消或作廢。');
    const sourceItems = normalizedOrderItems(order);
    const requestedByIndex = new Map();
    for (const line of lines) {
        const index = Number(line.orderItemIndex);
        const source = sourceItems[index];
        const sourceItemCode = String(source?.itemCode || '').trim();
        const lineItemCode = String(line?.itemCode || '').trim();
        const stableItemMismatch = !!(line?.itemId && source?.itemId && line.itemId !== source.itemId);
        if (!Number.isInteger(index) || !source || stableItemMismatch
            || (sourceItemCode && lineItemCode && sourceItemCode !== lineItemCode)) {
            throw new Error('來源訂單品項已變更，請重新建立採購單。');
        }
        requestedByIndex.set(index, (requestedByIndex.get(index) || 0) + Number(line.qty || 0));
    }
    for (const [index, qty] of requestedByIndex) {
        const source = sourceItems[index];
        const remaining = remainingProcurementQty(order, source);
        if (!(qty > 0) || qty > remaining + 1e-9) throw new Error('待採購數量已變更，請重新開啟來源訂單。');
    }
}

function poPdfFileName(poNo, vendorName) {
    const raw = [poNo, vendorName].filter(Boolean).join('-') || '採購單';
    return raw.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim() + '.pdf';
}

function normalizePoPdfFields(root) {
    const expected=root.querySelector('#poExpectedDate');
    if(expected){const label=expected.parentElement.querySelector('label[style]');if(label)label.style.display='';}
    root.querySelectorAll('.no-print').forEach(node => node.remove());
    root.querySelectorAll('input').forEach(input => {
        const span = document.createElement('span');
        span.className = 'po-pdf-field-value';
        span.textContent = input.value || '';
        input.replaceWith(span);
    });
    root.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
}

function createPoPdfStage() {
    const source = document.getElementById('printablePO');
    if (!source) throw new Error('找不到採購單內容');

    const stage = document.createElement('div');
    stage.className = 'quote-pdf-stage po-pdf-stage';
    const documentNode = document.createElement('div');
    documentNode.className = 'po-pdf-document po-pdf-page';
    const text = id => document.getElementById(id)?.textContent || '';
    const value = id => document.getElementById(id)?.value || '';
    documentNode.innerHTML = `
        <div class="header-container"><div class="header-info">
            <h1>${escapeHtml(text('poCompTitle'))}</h1><h2>${escapeHtml(text('poCompSub'))}</h2>
            <p>${escapeHtml(text('poCompAddr'))}</p><p>${escapeHtml(text('poCompContact'))}</p>
        </div></div>
        <h2 style="text-align:center;letter-spacing:10px;margin:10px 0;">採 購 單</h2>
        <div class="meta-row-three">
            <div>抬頭：${escapeHtml(value('poVendorName'))}</div>
            <div>採購人員：${escapeHtml(text('poBuyerName'))}</div>
            <div>採購日期：${escapeHtml(value('poDate'))}</div>
        </div>
        <div class="meta-row-three"><div>預計到貨日：${escapeHtml(value('poExpectedDate'))}</div><div>單號：${escapeHtml(text('poNo'))}</div></div>
        <table style="width:100%;margin-top:8px;border-collapse:collapse;">
            <thead><tr><th>品名 / 規格</th><th>貨號</th><th>廠牌</th><th>數量</th><th>單價</th><th>小計</th></tr></thead>
            <tbody>${poItems.map(item => `<tr><td>${escapeHtml(item.itemName||'')}${item.spec?`<br>${escapeHtml(item.spec)}`:''}</td><td>${escapeHtml(item.itemCode||'')}</td><td>${escapeHtml(item.brand||'')}</td><td>${Number(item.qty||0)}</td><td>${Number(item.unitPrice||0).toLocaleString('zh-TW')}</td><td>${(Number(item.qty||0)*Number(item.unitPrice||0)).toLocaleString('zh-TW')}</td></tr>`).join('')}</tbody>
        </table>
        <div class="po-total-section" style="text-align:right;margin-top:10px;">
            <p>未稅合計：NT$ ${escapeHtml(text('poSubtotal'))}</p><p>營業稅（5%）：NT$ ${escapeHtml(text('poTax'))}</p><p><b>總計金額：NT$ ${escapeHtml(text('poGrandTotal'))}</b></p>
        </div>`;
    stage.appendChild(documentNode);
    document.body.appendChild(stage);
    return { stage, documentNode };
}

function createPoPdfPage(stage, source, includeHeader = false) {
    const page = document.createElement('div');
    page.className = 'po-pdf-page';

    const sourceTable = source.querySelector('table');
    if (includeHeader) {
        for (const child of [...source.children]) {
            if (child === sourceTable) break;
            page.appendChild(child.cloneNode(true));
        }
    }

    const table = sourceTable.cloneNode(false);
    table.removeAttribute('id');
    const thead = sourceTable.querySelector('thead');
    if (thead) table.appendChild(thead.cloneNode(true));
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    page.appendChild(table);
    stage.appendChild(page);
    return { page, tbody };
}

function paginatePoPdfDocument(stage, source) {
    const sourceTable = source.querySelector('table');
    if (!sourceTable) return [source];
    const rows = [...sourceTable.querySelectorAll('tbody tr')];
    const summary = source.querySelector('.po-total-section');
    const maxHeight = quotePdfPageHeightPx(stage);

    source.style.display = 'none';
    const pages = [];
    let current = createPoPdfPage(stage, source, true);
    pages.push(current);

    for (const row of rows) {
        const clone = row.cloneNode(true);
        current.tbody.appendChild(clone);
        if (current.page.scrollHeight > maxHeight && current.tbody.children.length > 1) {
            clone.remove();
            current = createPoPdfPage(stage, source, false);
            pages.push(current);
            current.tbody.appendChild(clone);
        }
    }

    if (summary) {
        const summaryClone = summary.cloneNode(true);
        current.page.appendChild(summaryClone);
        if (current.page.scrollHeight > maxHeight) {
            summaryClone.remove();
            const donor = current;
            const finalPage = createPoPdfPage(stage, source, false);
            pages.push(finalPage);
            finalPage.page.appendChild(summaryClone);

            // 與估價單相同：最後一頁優先保留合計區，再把前頁最後的品項往後搬，
            // 只要超出 A4 可用高度就立即放回，避免產生大片空白或切到合計內容。
            while (donor.tbody.lastElementChild) {
                const candidate = donor.tbody.lastElementChild;
                finalPage.tbody.prepend(candidate);
                if (finalPage.page.scrollHeight > maxHeight) {
                    donor.tbody.appendChild(candidate);
                    break;
                }
            }
        }
    }

    source.remove();
    return pages.map(entry => entry.page);
}

async function printSavedPoDocument(poNo, vendorName) {
    const options=arguments[2]||{};
    let stage = null;
    const button = document.getElementById('printPurchaseOrderBtn');
    const download = options.download !== false;
    const modalGeneration = poDirectStockOpenGeneration;
    const exportingPoId = poEditingId;
    try {
        if (typeof window.html2canvas !== 'function' || !window.jspdf?.jsPDF) {
            throw new Error('PDF 元件尚未載入');
        }

        if (button) {
            button.disabled = true;
            button.innerText = download ? '準備 PDF…' : '準備附件…';
        }
        updatePoSaveStatus(download ? '正在準備採購單 PDF…' : '正在準備郵件附件…');

        const exportDom = createPoPdfStage();
        stage = exportDom.stage;
        await waitForPdfImages(exportDom.documentNode);

        const isSinglePage = exportDom.documentNode.scrollHeight <= quotePdfPageHeightPx(stage) - 12;
        const pages = isSinglePage ? [exportDom.documentNode] : paginatePoPdfDocument(stage, exportDom.documentNode);
        if (!isSinglePage) await waitForPdfImages(stage);

        const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
        const scale = isMobile ? 1.15 : 1.65;
        const pdf = new window.jspdf.jsPDF({ orientation:'portrait', unit:'mm', format:'a4', compress:!isSinglePage });

        await addDocumentPagesToPdf(pdf, pages, {
            scale,
            isolateRoot:stage,
            onProgress: (pageNo, pageCount) => {
                if (button) button.innerText = `正在產生 PDF… ${pageNo}/${pageCount}`;
                updatePoSaveStatus(`正在產生採購單 PDF… ${pageNo}/${pageCount}`);
            }
        });

        const fileName=poPdfFileName(poNo, vendorName);
        const blob=pdf.output('blob');
        if(download){
            if (button) button.innerText = '正在下載 PDF…';
            if (await window.DocumentDownloads.savePdf('purchase', pdf, fileName) === false) {
                updatePoSaveStatus('採購單 PDF 已產生；已取消匯出');
                return {blob,fileName};
            }
            updatePoSaveStatus('✓ 採購單 PDF 已產生');
            if(poDirectStockOpenGeneration===modalGeneration&&poEditingId===exportingPoId)closePurchaseOrderModal();
            showActionFeedback(`採購單 ${poNo} PDF 已匯出。`,'success');
        }else{
            updatePoSaveStatus('✓ 採購單 PDF 附件已準備');
        }
        return {blob,fileName};
    } finally {
        stage?.remove();
    }
}

window.printPurchaseOrder = async function() {
    if (poSaveInProgress) return;
    if (!canCreatePurchaseOrderCapability() || !canAccessPage('orders.po')) return;
    const leadDaysInput=document.getElementById('poLeadDays');
    if(!poEditingId&&leadDaysInput?.value&&(!Number.isInteger(Number(leadDaysInput.value))||Number(leadDaysInput.value)<0)){
        updatePoSaveStatus('預計交期請輸入 0 或以上的整數天數。',true);
        return;
    }
    if (!poEditingId && !poNoReady) {
        updatePoSaveStatus(poNoLoading ? '採購單號仍在產生中，完成後即可列印 / 存為 PDF。' : '採購單號尚未就緒，請切換公司或重新開啟後再試。', !poNoLoading);
        return;
    }
    poSaveInProgress = true;
    try { await window.DocumentDownloads.prepare('purchase'); }
    catch (err) { updatePoSaveStatus(err.message, true); return; }
    finally { poSaveInProgress = false; }
    if (poEditingId) {
        const savedPo = poListCache.find(po => po.id === poEditingId);
        if (!savedPo) { alert('找不到已儲存的採購單，請重新整理。'); return; }
        if (!poIncomingSyncPending) {
            const button = document.getElementById('printPurchaseOrderBtn');
            poSaveInProgress = true;
            try {
                await printSavedPoDocument(savedPo.poNo, savedPo.vendorName);
                db.collection('purchaseOrders').doc(savedPo.id).set({
                    lastOutputAt: new Date().toISOString(),
                    lastOutputType: 'PDF'
                }, { merge:true }).catch(err => console.warn('更新採購單輸出時間失敗：', err));
            } catch (err) {
                console.error('產生採購單 PDF 失敗：', err);
                updatePoSaveStatus('產生採購單 PDF 失敗：' + (err?.message || err), true);
            } finally {
                poSaveInProgress = false;
                if (button) button.disabled = false;
                updatePoSaveButton();
            }
            return;
        }
        const button = document.getElementById('printPurchaseOrderBtn');
        poSaveInProgress = true;
        if (button) { button.disabled = true; button.innerText = '同步雲端後開啟列印…'; }
        try {
            await registerPurchaseIncoming(savedPo.id, savedPo);
            poIncomingSyncPending = false;
            updatePoSaveStatus(`採購單 ${savedPo.poNo} 已同步雲端，正在產生 PDF…`);
            await printSavedPoDocument(savedPo.poNo, savedPo.vendorName);
        } catch (err) {
            updatePoSaveStatus(`採購單已同步雲端，但在途庫存同步仍未完成：${err.message}`, true);
        } finally {
            poSaveInProgress = false;
            if (button) button.disabled = false;
            updatePoSaveButton();
        }
        return;
    }
    if (poItems.length === 0) {
        alert('目前沒有任何品項，請先選取或不要刪光所有品項。');
        return;
    }
    if (poItems.some(item => !Number.isFinite(Number(item.qty)) || Number(item.qty) <= 0)) {
        alert('每個採購品項的數量都必須大於 0。');
        return;
    }
    if (poDirectStockMode && poItems.some(item => (item.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP')) {
        alert('新增庫存採購單是公司庫存採購，不能設定為原廠直送。');
        return;
    }
    if (poDirectStockMode && poItems.some(item => !String(item.warehouseId || defaultWarehouse()?.id || '').trim())) {
        alert('新增庫存採購單必須指定入庫倉庫，請先建立或選擇倉庫。');
        return;
    }
    if (poDirectStockMode) {
        const unmatchedStockItems = poItems.filter(item => {
            const productId = String(item.productId || '').trim();
            const match = findPriceItemForOrder({ itemCode:item.itemCode || '', brand:item.brand || '' });
            if (!productId || !match) return true;
            const matchedProductId = String(match.productId || stableProductId(match) || '').trim();
            return matchedProductId !== productId
                || normalizeBrandLookupKey(match.brand || '') !== normalizeBrandLookupKey(item.brand || '');
        });
        if (unmatchedStockItems.length) {
            alert('庫存採購的每個品項都必須對應產品主檔。請重新選擇有效貨號後再建立採購單。');
            return;
        }
    }
    if (poItems.some(item => (item.fulfillmentType || 'WAREHOUSE') !== 'DIRECT_SHIP' && !String(item.warehouseId || defaultWarehouse()?.id || '').trim())) {
        alert('入庫品項必須有倉庫，請先在倉庫管理建立預設倉庫。');
        return;
    }
    const invalidIdentityItems = poItems.filter(item => !String(item.itemCode||'').trim() || !String(item.itemName||'').trim() || !String(item.brand||'').trim());
    if (invalidIdentityItems.length) {
        alert('請完成每個採購品項的貨號、品名與廠牌。');
        return;
    }
    const missingPriceItems = poItems.filter(item => item.unitPrice === null || item.unitPrice === undefined || item.unitPrice === '' || !Number.isFinite(Number(item.unitPrice)) || Number(item.unitPrice) < 0);
    if (missingPriceItems.length) {
        alert(`以下品項尚未填入有效的進貨單價：${missingPriceItems.map(item => item.itemName || item.itemCode || '未命名品項').join('、')}`);
        return;
    }
    // 訂單裡存的廠牌，如果當初是透過估價單「其他（自行輸入）」填的自訂名稱，不會出現在正式廠牌清單裡；
    // 只要目前公司有開放「其他廠牌」，這種自訂名稱就不能當作違規
    if (poItems.some(item => !isCompanyBrandAllowed(poCurrentCompany, item.brand) && !isCompanyOtherOptionAllowed(poCurrentCompany))) {
        alert('採購單含有不屬於目前分公司代理的廠牌，請切換分公司或移除該品項。');
        return;
    }
    const vendorName = document.getElementById('poVendorName').value.trim();
    if (!vendorName) {
        alert('請填寫供應商名稱。');
        return;
    }
    const poNo = document.getElementById('poNo').innerText.trim();
    if (!poNo || poNo === '產生中…' || poNo === '—') {
        updatePoSaveStatus('採購單號尚未就緒，請切換公司或重新開啟後再試。', true);
        return;
    }
    const orderIds = [...new Set(poItems.map(item => item.orderId).filter(Boolean))];
    const poNetTotal = poItems.reduce((sum, item) => sum + (Number(item.qty || 0) * Number(item.unitPrice || 0)), 0);
    const supplierContact = supplierForVendorName(vendorName);
    if (!globalThis.YushinSupplier?.snapshotForPurchaseOrder) {
        throw new Error('Supplier core 未載入，無法建立供應商快照。');
    }
    const supplierSnapshot=globalThis.YushinSupplier.snapshotForPurchaseOrder(
        supplierContact||{},
        {supplierName:vendorName,purchaseHeaderName:vendorName}
    );
    const poDate=document.getElementById('poDate').value;
    const expectedDateInput=document.getElementById('poExpectedDate');
    const expectedDate=expectedDateInput?.value||'';
    const expectedDateSource=expectedDateInput?.dataset.expectedDateSource
        || (expectedDate ? 'manual' : '');
    const scheduledPoItems=poItemsWithScheduleDates(
        poItems,
        supplierSnapshot.supplierId||'',
        poDate,
        expectedDate,
        expectedDateSource
    );
    const poRecord = {
        poNo,
        company: poCurrentCompany,
        vendorName:supplierSnapshot.purchaseHeaderName||vendorName,
        supplierId:supplierSnapshot.supplierId||'',
        supplierName:supplierSnapshot.supplierName||vendorName,
        supplierEmail:supplierSnapshot.email||'',
        supplierSnapshot,
        buyerName: document.getElementById('poBuyerName').innerText || currentUserName || '',
        poDate,
        expectedDate,
        expectedDateSource,
        scheduleDate:expectedDate,
        purchaseType: poItems.every(item => !item.orderId) ? 'stock' : 'order',
        items: scheduledPoItems.map(item => {
            const brand = resolveBrandName(item.brand || '');
            return { ...item, brand, brandId:item.brandId || brandIdForName(brand) };
        }),
        ...netAmountMetadata(poNetTotal),
        createdAt: new Date().toISOString(),
        lastOutputAt: new Date().toISOString(),
        lastOutputType: 'PDF',
        ...linkedDocumentFields(orderIds.length === 1 ? DOCUMENT_TYPES.ORDER : '', orderIds.length === 1 ? orderIds[0] : '', orderIds.map(orderId => documentLink(DOCUMENT_TYPES.ORDER, orderId, 'source')))
    };
    poRecord.searchTokens=purchaseOrderSearchTokens(poRecord);
    const button = document.getElementById('printPurchaseOrderBtn');
    poSaveInProgress = true;
    if (button) {
        button.disabled = true;
        button.innerText = '同步雲端中…';
    }
    updatePoSaveStatus('正在同步採購單到雲端…');
    let poCommitted = false;
    try {
        const poDocumentId = poNo;
        let committedSourceOrders = [];
        let committedSupplyOrders = [];
        const commitPromise = runRoleTransaction(async transaction => {
            committedSourceOrders = [];
            committedSupplyOrders = [];
            const poRef = db.collection('purchaseOrders').doc(poDocumentId);
            const orderRefs = orderIds.map(orderId => db.collection('orders').doc(orderId));
            const poSnapshot = await transaction.get(poRef);
            const orderSnapshots = await Promise.all(orderRefs.map(ref => transaction.get(ref)));
            if (poSnapshot.exists) throw new Error(`採購單號 ${poNo} 已存在，請關閉視窗後重新產生單號。`);
            orderSnapshots.forEach((snapshot, index) => {
                if (!snapshot.exists) throw new Error('來源訂單已不存在。');
                assertPurchaseLinesAvailable(snapshot.data(), poRecord.items.filter(item => item.orderId === orderIds[index]));
            });
            const supplyOrderIds = [];
            poRecord.items.forEach((item,itemIndex)=>{
                const sourceType=item.sourceType||(item.orderId?'SALES_ORDER':'STOCK_REPLENISHMENT');
                let demandProjection;
                let sourceOrderForDemand=null;
                let sourceItemForDemand=null;
                if(sourceType==='SALES_ORDER'){
                    const sourceSnapshot=orderSnapshots.find(snapshot=>snapshot.id===item.orderId);
                    if(!sourceSnapshot?.exists)throw new Error('採購需求找不到來源訂單。');
                    sourceOrderForDemand={id:sourceSnapshot.id,...sourceSnapshot.data()};
                    const sourceItems=normalizedOrderItems(sourceOrderForDemand);
                    sourceItemForDemand=sourceItems.find(row=>row.itemId===item.itemId)
                        || sourceItems[Number(item.orderItemIndex||0)];
                    if(!sourceItemForDemand)throw new Error('採購需求找不到來源訂單品項。');
                    demandProjection=procurementDemandForOrderItem(sourceOrderForDemand,sourceItemForDemand);
                }else{
                    demandProjection=globalThis.YushinProcurementDemand.normalizeDemand({
                        demandId:item.demandId||globalThis.YushinProcurementDemand.demandIdForSource({
                            sourceType,sourceId:item.sourceId||item.productId||item.itemCode||''
                        }),
                        sourceType,
                        sourceId:item.sourceId||item.productId||item.itemCode||'',
                        sourceItemId:'',
                        requestedQty:Number(item.demandRequestedQty??item.qty??0),
                        orderedQty:Number(item.demandOrderedQty||0),
                        receivedQty:Number(item.demandReceivedQty||0),
                        // Stock replenishment has no customer required-by date by default.
                        // item.scheduleDate here is supplier ETA and must not become demand timing.
                        scheduleDate:String(item.demandScheduleDate||item.requiredByDate||'').trim()
                    });
                }
                const demandOrderPlan=globalThis.YushinProcurementDemand.applyOrder(demandProjection,Number(item.qty||0));
                if(demandOrderPlan.appliedQty!==Number(item.qty||0)){
                    throw new Error('採購需求數量已變更，請重新整理後再建立採購單。');
                }
                const demandRef=procurementDemandRef(demandProjection.demandId);
                const demandDoc=procurementDemandDocument(demandOrderPlan.demand,{
                    productId:item.productId||sourceItemForDemand?.productId||'',
                    productKey:poIncomingKey(item)||inventoryProductKey(sourceItemForDemand||{}),
                    itemCode:item.itemCode||sourceItemForDemand?.itemCode||'',
                    itemName:item.itemName||sourceItemForDemand?.itemName||'',
                    brand:resolveBrandName(item.brand||sourceItemForDemand?.brand||''),
                    fulfillmentType:item.fulfillmentType||sourceItemForDemand?.fulfillmentType||'WAREHOUSE',
                    warehouseId:(item.fulfillmentType||sourceItemForDemand?.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP'
                        ? '' : (item.warehouseId||sourceItemForDemand?.warehouseId||defaultWarehouse()?.id||''),
                    ownerUid:item.ownerUid||sourceOrderForDemand?.ownerUid||'',
                    salesCode:item.salesCode||sourceOrderForDemand?.salesCode||'',
                    salesName:item.salesName||sourceOrderForDemand?.salesName||'',
                    // Preserve Material Request required-by timing. Do not overwrite it
                    // with this PO line's vendor delivery estimate.
                    scheduleDate:demandProjection.scheduleDate
                        ||sourceItemForDemand?.requiredByDate
                        ||sourceItemForDemand?.scheduleDate
                        ||sourceOrderForDemand?.requiredByDate
                        ||sourceOrderForDemand?.expectedDate
                        ||''
                },{
                    createdAt:sourceOrderForDemand?.createdAt||poRecord.createdAt,
                    updatedAt:poRecord.createdAt
                });

                const supplyId=formalSupplyOrderId(poDocumentId,itemIndex);
                const supplyRef=supplyOrdersCollection().doc(supplyId);
                supplyOrderIds.push(supplyId);
                const supplyRecord={
                    // ERPNext-style：採購方式與需求來源分開。
                    // 正式採購單永遠是 PURCHASING_PO；是否為客戶需求或備庫由 sourceType 表示。
                    type:'PURCHASING_PO',
                    method:'PURCHASING_PO',
                    sourceType,
                    sourceId:item.orderId||item.sourceId||'',
                    sourceItemId:item.itemId||item.sourceItemId||'',
                    demandId:demandProjection.demandId||'',
                    internalNo:poNo,
                    purchaseDocumentId:poDocumentId,
                    purchaseDocumentNo:poNo,
                    status:'ORDERED',
                    orderId:item.orderId||'',
                    itemId:item.itemId||'',
                    orderItemIndex:Number(item.orderItemIndex||0),
                    ownerUid:item.ownerUid||'',
                    salesCode:item.salesCode||'',
                    salesName:item.salesName||'',
                    productId:item.productId||'',
                    productKey:poIncomingKey(item),
                    itemCode:item.itemCode||'',
                    itemName:item.itemName||'',
                    brand:resolveBrandName(item.brand||''),
                    brandId:item.brandId||brandIdForName(item.brand||''),
                    qty:Number(item.qty||0),
                    receivedQty:0,
                    incomingRegisteredQty:0,
                    supplier:poRecord.supplierName||vendorName,
                    supplierId:poRecord.supplierId||'',
                    supplierEmail:poRecord.supplierEmail||'',
                    unitCost:Number(item.unitPrice||0),
                    orderDate:poRecord.poDate,
                    expectedDate:item.scheduleDate||poRecord.expectedDate||'',
                    scheduleDate:item.scheduleDate||poRecord.scheduleDate||poRecord.expectedDate||'',
                    fulfillmentType:item.fulfillmentType||'WAREHOUSE',
                    warehouseId:(item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP'?'':(item.warehouseId||defaultWarehouse()?.id||''),
                    createdAt:poRecord.createdAt,
                    updatedAt:poRecord.createdAt,
                    createdByUid:currentUser?.uid||'',
                    createdBy:currentUserName||currentUser?.email||'',
                    createdByRole:currentUserRole
                };
                transaction.set(supplyRef,supplyRecord);
                if(demandRef)transaction.set(demandRef,demandDoc,{merge:true});
                committedSupplyOrders.push({id:supplyId,...supplyRecord});
            });
            poRecord.supplyOrderIds=supplyOrderIds;
            transaction.set(poRef, poRecord);
            orderSnapshots.forEach((snapshot, index) => {
                if (snapshot.exists) {
                    const orderData = snapshot.data();
                    const orderedLines=poRecord.items.filter(item=>item.orderId===snapshot.id);
                    const nextItems=normalizedOrderItems(orderData).map((item,itemIndex)=>{
                        const matches=orderedLines.filter(line=>Number(line.orderItemIndex)===itemIndex);
                        const orderedQty=matches.reduce((sum,line)=>sum+Number(line.qty||0),0);
                        const currentSupplyOrdered=Math.max(0,Number(item.supplyOrderedQty||0));
                        const cumulative=currentSupplyOrdered+orderedQty;
                        const identityLine=matches.find(line=>line.itemId&&item.itemId&&line.itemId===item.itemId)||matches[0];
                        return orderedQty>0?{
                            ...item,
                            // 採購單可補齊來源訂單原本缺少的產品識別資料；已有值不覆蓋，
                            // 避免「來源貨號空白 → 採購頁可填 → 儲存又被擋住」的死路流程。
                            productId:item.productId||identityLine?.productId||'',
                            itemCode:item.itemCode||identityLine?.itemCode||'',
                            itemName:item.itemName||identityLine?.itemName||'',
                            brand:item.brand||resolveBrandName(identityLine?.brand||''),
                            brandId:item.brandId||identityLine?.brandId||brandIdForName(item.brand||identityLine?.brand||''),
                            productLine:item.productLine||identityLine?.productLine||'',
                            supplyOrderedQty:cumulative,
                            purchaseDocumentNos:[...new Set([...(item.purchaseDocumentNos||[]),poNo])],
                            orderedAt:item.orderedAt && item.orderedAt < poRecord.poDate ? item.orderedAt : poRecord.poDate,
                            orderEvents:[
                                ...(item.orderEvents||[]).filter(event=>event.id!==poDocumentId),
                                {id:poDocumentId,type:'PURCHASING_PO',at:poRecord.createdAt||new Date().toISOString(),date:poRecord.poDate||'',qty:orderedQty,documentNo:poNo,by:poRecord.buyerName||currentUserName||currentUser?.email||''}
                            ]
                        }:item;
                    });
                    const nextOrderData={...orderData,items:nextItems,itemCount:nextItems.length,orderSchemaVersion:2};
                    const orderUpdates = {
                        items:nextItems,itemCount:nextItems.length,orderSchemaVersion:2,
                        ...orderWorkIndexFields(nextOrderData),
                        linkedDocuments: normalizeDocumentLinks([...(orderData.linkedDocuments || []), documentLink(DOCUMENT_TYPES.PURCHASE_ORDER, poDocumentId, 'document')])
                    };
                    transaction.update(orderRefs[index], orderUpdates);
                    committedSourceOrders.push({id:snapshot.id,...orderData,...orderUpdates});
                }
            });
        });

        // 採購單會同時改寫來源訂單與供應紀錄，不能像估價單一樣「先印再存」：
        // 若 iPhone 在列印畫面直接關閉頁面，背景 transaction 可能尚未完成，會造成紙本已下單但系統沒有紀錄。
        // 只等待這個最小且必要的核心 transaction；在途庫存仍於列印後背景同步。
        updatePoSaveStatus('正在確認並儲存採購單…');
        await commitPromise;
        poCommitted = true;
        invalidateProcurementDemandQueue();
        if (button) button.innerText = '同步在途庫存中…';

        // The PO + source-order linkage above is the authoritative commit.
        // Cache it before the separate incoming-stock registration so a transient
        // failure can retry the same PO idempotently instead of attempting to
        // create another PO with the same number.
        syncCommittedPurchaseOrderSources(committedSourceOrders);
        // 正式 PO 已成功建立時，立即把供應紀錄放進待到貨快取。
        // 避免使用者本工作階段曾開過待到貨後，新增備庫 PO 卻要手動更新才看得到。
        if (committedSupplyOrders.length) {
            const supplyMap = new Map(supplyReceivingCache.map(row => [row.id, row]));
            committedSupplyOrders.forEach(row => supplyMap.set(row.id, row));
            supplyReceivingCache = [...supplyMap.values()]
                .sort((a,b)=>String(b.orderDate||b.createdAt||'').localeCompare(String(a.orderDate||a.createdAt||'')));
        }
        const savedPo = { id: poDocumentId, ...poRecord };
        const cachedIndex = poListCache.findIndex(po => po.id === savedPo.id);
        if (cachedIndex >= 0) poListCache[cachedIndex] = savedPo;
        else poListCache.unshift(savedPo);
        poEditingId = savedPo.id;
        poIncomingSyncPending = true;
        updatePoModeUI();
        updatePoSaveStatus(`採購單 ${poNo} 已同步雲端；正在產生 PDF，在途庫存稍後背景同步…`);

        // 核心 transaction 完成後才輸出 PDF，確保使用者拿到的正式文件一定有對應的系統紀錄。
        // PDF 使用與估價單相同的逐頁 Canvas → jsPDF 流程，不再依賴瀏覽器列印視窗。
        await printSavedPoDocument(poNo, vendorName);

        // PO 與來源訂單已在上方同一個 transaction 成功提交；列印不等待第二段在途庫存同步。
        // 在途同步以 PO id 冪等處理，失敗時仍可由同一張 PO 重試，不會重複建立採購單。
        registerPurchaseIncoming(poDocumentId, poRecord)
            .then(() => {
                if(poEditingId===poDocumentId)poIncomingSyncPending = false;
                if (document.getElementById('purchasing-system')?.classList.contains('active')) renderPurchasingView();
                if(poEditingId===poDocumentId){
                    updatePoSaveStatus(`採購單 ${poNo} 已建立；在途庫存同步完成。`);
                    updatePoSaveButton();
                }
            })
            .catch(err => {
                console.error('採購單在途庫存背景同步失敗：', err);
                if(poEditingId===poDocumentId){
                    poIncomingSyncPending = true;
                    updatePoSaveStatus(`採購單已同步雲端，但在途庫存同步未完成：${err.message}。請由這張採購單重試同步，不要另建一張。`, true);
                    updatePoSaveButton();
                }
                showActionFeedback(`採購單 ${poNo} 已建立；在途同步未完成，請開啟這張採購單重試。`,'warning');
            });
    } catch (err) {
        console.error('儲存採購單紀錄失敗：', err);
        updatePoSaveStatus(poCommitted
            ? `採購單已同步雲端，但在途庫存同步未完成：${err.message}`
            : `採購單未建立：${err.message}`, true);
        alert(poCommitted
            ? '採購單已同步雲端，但在途庫存同步未完成。請在這張採購單按「重試同步在途庫存」，不要另建一張：' + err.message
            : '無法產生採購單：' + err.message);
    } finally {
        poSaveInProgress = false;
        if (button) {
            button.disabled = false;
        }
        updatePoSaveButton();
    }
};

// 「製作下一張估價單」：手動觸發，不會因為誤按列印視窗的取消鈕就被清空。
// 按下後會先確認，避免不小心點到把還沒印的內容洗掉；確認後清空表單、單號跳下一號，
// 並且立刻把這個「全新、還是空的」狀態存成本機草稿，這樣萬一使用者按完馬上關網頁，
// 重開時看到的會是這張全新的空白單，而不是被清掉的上一張。
window.startNextQuote = function() {
    if (!confirm('確定要開始製作下一張估價單嗎？目前畫面上的內容將會被清空（如果還沒匯出 PDF，請先確認已經處理好）。')) return;
    setQuoteEditingContext('');
    setQuoteOutputStatus('');
    resetQuoteFormForNextOne();
    saveQuoteDraft();
};

function resetQuoteFormForNextOne() {
    document.getElementById('clientName').value = '';
    document.getElementById('ordererName').value = '';
    document.getElementById('discountRateInput').value = 0;
    document.getElementById('validDays').value = 90;
    document.getElementById('quoteRemarks').value = '';

    document.getElementById('quoteItems').innerHTML = '';
    addQuoteRow();
    calculateTotals();

    // 單號直接把目前這組號碼的流水號 +1，不重新查一次雲端——
    // 因為上一張單的雲端存檔是背景進行、不保證這時候已經真的寫進 Firestore，
    // 這時如果重新查詢「目前最大流水號」，很可能還查到上一張存檔前的舊資料，算出來的下一號反而會撞號
    const quoteNoInput = document.getElementById('quoteNo');
    const parts = (quoteNoInput.value || '').split('-');
    const lastPart = parts[parts.length - 1];
    const lastSeq = parseInt(lastPart, 10);
    if (parts.length >= 2 && !isNaN(lastSeq)) {
        parts[parts.length - 1] = String(lastSeq + 1).padStart(lastPart.length, '0');
        quoteNoInput.value = parts.join('-');
    }
}

// 新增：處理狀態切換的函數
// 先在畫面上立即反應（樂觀更新），不用等雲端回應才變色，感覺上會快很多；
// 如果雲端寫入失敗，才把狀態復原並提示錯誤
window.toggleOrderStatus = function(orderId, field, newValue) {
    if (!canManageOrderLifecycleCapability() || !canEditPage('orders.list')) return;
    if (field !== 'isBilled') {
        alert('訂貨、到貨與送貨狀態已由 V2 採購／入庫／打單流程自動管理。');
        return;
    }
    const o = ordersCache.find(x => x.id === orderId);
    if (!o || !canEditPage('orders.list')) return;
    const pendingKey = `${orderId}:isBilled`;
    if (pendingOrderStatusKeys.has(pendingKey)) return;
    if (normalizedOrderStatus(o) !== 'normal') { alert('已取消的訂單不能更改進度。'); return; }

    const billingDate = newValue ? (orderBillingDate(o) || localDateString()) : '';
    const previousWorkFilter = activeOrderWorkFilter;
    const previous = {
        isBilled: o.isBilled,
        billingDate: o.billingDate || '',
        status: o.status,
        statusHistory: [...(o.statusHistory || [])]
    };
    const actor = currentUserName || currentUser?.email || '未知使用者';
    const timestamp = new Date().toISOString();
    const logEntry = { field:'isBilled', value:newValue, label:newValue ? '已核銷' : '取消已核銷', by:actor, at:timestamp };

    o.isBilled = newValue;
    o.billingDate = billingDate;
    if (!newValue && activeOrderWorkFilter === 'complete') activeOrderWorkFilter = 'billing';
    if (newValue && activeOrderWorkFilter === 'billing' && deliveryProgressInfo(o).state === 'complete') activeOrderWorkFilter = 'complete';
    o.statusHistory = [...previous.statusHistory, logEntry];
    pendingOrderStatusKeys.add(pendingKey);
    writeAppDataCache('orders', ordersCache);
    renderOrdersList();

    let committed;
    runRoleTransaction(async transaction => {
        const ref = db.collection('orders').doc(orderId);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new Error('找不到這筆訂單。');
        const order = snapshot.data();
        if (normalizedOrderStatus(order) !== 'normal') throw new Error('這筆訂單已取消。');
        const updates = {
            isBilled:newValue,
            billingDate,
            status:BUSINESS_STATUS.ACTIVE,
            updatedAt: timestamp,
            statusHistory:firebase.firestore.FieldValue.arrayUnion(logEntry)
        };
        Object.assign(updates,orderWorkIndexFields({...order,...updates}));
        transaction.update(ref, updates);
        committed = {
            isBilled:newValue,
            billingDate,
            status:BUSINESS_STATUS.ACTIVE,
            statusHistory:[...(order.statusHistory || []),logEntry]
        };
    }).then(() => {
        Object.assign(o, committed);
        pendingOrderStatusKeys.delete(pendingKey);
        writeAppDataCache('orders', ordersCache);
        renderOrdersList();
        if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
    }).catch(err => {
        Object.assign(o, previous);
        pendingOrderStatusKeys.delete(pendingKey);
        activeOrderWorkFilter = previousWorkFilter;
        writeAppDataCache('orders', ordersCache);
        renderOrdersList();
        if (currentDeliveryOrderId === orderId) {
            renderDeliveryModal();
            renderOrderLifecycleModal();
        }
        alert('更新狀態失敗，已還原：' + err.message);
    });
};

window.updateOrderBillingDate = function(orderId, value) {
    const order = ordersCache.find(item => item.id === orderId);
    if (!order || !order.isBilled || !canEditPage('orders.list')) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) { alert('請選擇正確的核銷日期。'); renderOrdersList(); return; }
    const previous = order.billingDate || '';
    if (previous === value) return;
    const history = {
        field: 'billingDate', label: '修改核銷日期', before: previous || orderBillingDate(order), after: value,
        by: currentUserName || currentUser?.email || '未知使用者', at: new Date().toISOString()
    };
    order.billingDate = value;
    order.fieldEditHistory = [...(order.fieldEditHistory || []), history];
    writeAppDataCache('orders', ordersCache);
    renderOrdersList();
    db.collection('orders').doc(orderId).update({ billingDate: value, updatedAt: history.at, fieldEditHistory: firebase.firestore.FieldValue.arrayUnion(history) }).catch(err => {
        order.billingDate = previous;
        order.fieldEditHistory = (order.fieldEditHistory || []).filter(item => item !== history);
        writeAppDataCache('orders', ordersCache);
        renderOrdersList();
        alert('更新核銷日期失敗，已還原：' + err.message);
    });
};

function formatOrderStatusTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

window.showCustomerOrderHistory = async function(customerName) {
    const customerKey = normalizeFullHistorySearchValue(customerName);
    if (!customerKey) return;
    const overlay = document.getElementById('customerOrderHistoryOverlay');
    const title = document.getElementById('customerOrderHistoryTitle');
    const summary = document.getElementById('customerTransactionSummary');
    const tbody = document.getElementById('customerOrderHistoryBody');
    const quoteTbody = document.getElementById('customerQuoteHistoryBody');
    if (title) title.innerText = `客戶近期交易摘要：${customerName}`;
    if (summary) summary.innerHTML = '<div class="customer-summary-card"><span>資料狀態</span><strong>讀取完整歷史中…</strong></div>';
    if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="color:#888;">讀取訂單歷史中…</td></tr>';
    if (quoteTbody) quoteTbody.innerHTML = '<tr><td colspan="6" style="color:#888;">讀取估價歷史中…</td></tr>';
    if (overlay) overlay.classList.add('active');

    try {
        const orderToken = fullHistoryQueryToken('order', customerName);
        const quoteToken = fullHistoryQueryToken('quote', customerName);
        const [orderSnap, quoteSnap] = await Promise.all([
            orderToken
                ? firestoreReadWithTimeout(scopedHistorySearchQuery('orders', orderToken).limit(DEFAULT_LIST_LIMIT).get(), '客戶訂單歷史')
                : Promise.resolve({ docs: [] }),
            quoteToken
                ? firestoreReadWithTimeout(scopedHistorySearchQuery('quotes', quoteToken).limit(DEFAULT_LIST_LIMIT).get(), '客戶估價歷史')
                : Promise.resolve({ docs: [] })
        ]);
        const exactCustomerKey = normalizeCustomerKey(customerName);
        const orders = (orderSnap.docs || [])
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(order => normalizeCustomerKey(order.customerName || order.customer || '') === exactCustomerKey)
            .sort((a, b) => String(b.orderDate || '').localeCompare(String(a.orderDate || '')));
        const quotes = (quoteSnap.docs || [])
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(quote => [quote.ordererName, quote.clientName].some(value => normalizeCustomerKey(value) === exactCustomerKey))
            .sort((a, b) => String(b.quoteDate || b.quoteNo || '').localeCompare(String(a.quoteDate || a.quoteNo || '')));
        const quoteItems = quotes.flatMap(quote => (quote.items || []).map(item => ({ quote, item })))
            .sort((a, b) => String(b.quote.quoteDate || b.quote.quoteNo || '').localeCompare(String(a.quote.quoteDate || a.quote.quoteNo || '')));
        const recentDates = [...orders.map(order => order.orderDate), ...quotes.map(quote => quote.quoteDate)].filter(Boolean).sort().reverse();
        const latestOrder = orders[0];
        const latestQuoteItem = quoteItems[0];
        const latestPrice = latestOrder
            ? `NT$ ${Number(parseFloat(String(latestOrder.unitPrice ?? '').replace(/,/g, '')) || 0).toLocaleString()}`
            : latestQuoteItem ? `NT$ ${Number(parseFloat(String(latestQuoteItem.item.price ?? '').replace(/,/g, '')) || 0).toLocaleString()}` : '－';
        const latestProduct = latestOrder?.itemName || latestQuoteItem?.item?.nameCn || latestQuoteItem?.item?.nameEn || '－';
        if (summary) summary.innerHTML = `
            <div class="customer-summary-card"><span>最近交易日</span><strong>${escapeHtml(recentDates[0] || '－')}</strong></div>
            <div class="customer-summary-card"><span>最近購買／估價品項</span><strong>${escapeHtml(latestProduct)}</strong></div>
            <div class="customer-summary-card"><span>上次單價</span><strong>${escapeHtml(latestPrice)}</strong></div>
            <div class="customer-summary-card"><span>最近估價</span><strong>${escapeHtml(quotes[0] ? `${quotes[0].quoteNo || '－'}／${quotes[0].quoteDate || '－'}` : '－')}</strong></div>`;
        if (tbody) tbody.innerHTML = orders.length ? orders.slice(0, 20).map(order => `
            <tr><td>${escapeHtml(order.orderDate || '')}</td><td>${escapeHtml(order.brand || '')}</td><td>${escapeHtml(order.itemCode || '')}</td><td>${escapeHtml(order.itemName || '')}</td><td>${escapeHtml(String(order.qty || ''))}</td><td>${escapeHtml(String(order.totalPrice || ''))}</td><td>${deliveryProgressInfo(order).delivered>0 ? (deliveryProgressInfo(order).state==='complete'?'已送貨':'部分送貨') : fulfillmentProgressInfo(order).shippable>0 ? '可出貨' : fulfillmentProgressInfo(order).pendingDispatch>0 ? '待打單' : purchaseProgressInfo(order).label}</td></tr>
        `).join('') : '<tr><td colspan="7" style="color:#888;">目前沒有訂單紀錄。</td></tr>';
        if (quoteTbody) quoteTbody.innerHTML = quoteItems.length ? quoteItems.slice(0, 20).map(({ quote, item }) => `
            <tr><td>${escapeHtml(quote.quoteDate || '')}</td><td>${escapeHtml(quote.quoteNo || '')}</td><td>${escapeHtml(item.nameCn || item.nameEn || item.model || '')}</td><td>${escapeHtml(String(item.qty || ''))}</td><td>${escapeHtml(String(item.price || ''))}</td><td>${quote.dealClosed ? '已成交' : '估價中'}</td></tr>
        `).join('') : '<tr><td colspan="6" style="color:#888;">目前沒有估價紀錄。</td></tr>';
    } catch (err) {
        console.error('讀取客戶完整交易歷史失敗：', err);
        if (summary) summary.innerHTML = '<div class="customer-summary-card"><span>資料狀態</span><strong>讀取失敗</strong></div>';
        if (tbody) tbody.innerHTML = '<tr><td colspan="7" style="color:#888;">無法讀取完整訂單歷史。</td></tr>';
        if (quoteTbody) quoteTbody.innerHTML = '<tr><td colspan="6" style="color:#888;">無法讀取完整估價歷史。</td></tr>';
    }
};

window.closeCustomerOrderHistory = function() {
    document.getElementById('customerOrderHistoryOverlay').classList.remove('active');
};

function deliveryRecordId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return `delivery-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function deliveryActor() {
    return currentUserName || currentUser?.email || '未知使用者';
}

function localDateString() {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function normalizeBusinessDate(value) {
    if (!value) return '';
    const raw = String(value).trim().replace(/\//g, '-');
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
    return dateOnlyFromTimestamp(value);
}

function unifiedPeriodRange(key = 'this-year') {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (key === 'all') return { start: '', end: '' };
    if (key === 'this-month') return { start: fmt(new Date(y, m, 1)), end: fmt(new Date(y, m + 1, 0)) };
    if (key === 'last-month') return { start: fmt(new Date(y, m - 1, 1)), end: fmt(new Date(y, m, 0)) };
    if (key === 'this-quarter') {
        const qStart = Math.floor(m / 3) * 3;
        return { start: fmt(new Date(y, qStart, 1)), end: fmt(new Date(y, qStart + 3, 0)) };
    }
    if (key === 'last-year') return { start: `${y - 1}-01-01`, end: `${y - 1}-12-31` };
    return { start: `${y}-01-01`, end: `${y}-12-31` };
}

function dateInUnifiedPeriod(value, key = 'this-year') {
    const date = normalizeBusinessDate(value);
    const { start, end } = unifiedPeriodRange(key);
    if (!start && !end) return true;
    return !!date && (!start || date >= start) && (!end || date <= end);
}

let orderProgressHistoryExpanded = false;
let currentOrderHistoryId = null;
let orderLifecycleFormOpen = false;
let orderReturnFormOpen = false;
window.selectOrderProgressTab = function(tab) {
    if (!['delivery', 'returns'].includes(tab)) return;
    ['delivery', 'returns'].forEach(name => {
        document.getElementById(`orderProgressPanel-${name}`).hidden = name !== tab;
        const button = document.getElementById(`orderProgressTab-${name}`);
        button.setAttribute('aria-selected', String(name === tab));
    });
};
window.showAllOrderProgressHistory = function() {
    orderProgressHistoryExpanded = true;
    const order = ordersCache.find(o => o.id === currentOrderHistoryId);
    if (order) renderOrderStatusHistory(order);
};
function labelOrderProgressRecords(bodyId, labels) {
    const body = document.getElementById(bodyId);
    if (!body) return;
    Array.from(body.rows).forEach(row => Array.from(row.cells).forEach((cell, i) => {
        if (cell.colSpan === 1) cell.dataset.label = labels[i];
    }));
}
window.closeOrderLifecycleForm = function() {
    orderLifecycleFormOpen = false;
    document.getElementById('orderStatusEditPanel').style.display = 'none';
};
window.openOrderLifecycleForm = function() {
    const order = ordersCache.find(o => o.id === currentLifecycleOrderId);
    if (!order || !canManageOrderLifecycleCapability() || !canEditPage('orders.list')) return;
    if (normalizedOrderStatus(order) === 'normal' && deliveryProgressInfo(order).remaining <= 0) return;
    selectOrderProgressTab('returns');
    orderLifecycleFormOpen = true;
    document.getElementById('orderLifecycleStatus').value = normalizedOrderStatus(order) === 'normal' ? 'cancelled' : 'normal';
    renderOrderLifecycleModal();
};
window.openReturnForm = function() {
    const order = ordersCache.find(o => o.id === currentLifecycleOrderId);
    if (!order || !canManageOrderLifecycleCapability() || !canEditPage('orders.list')) return;
    if (!normalizedOrderItems(order).some(item => returnItemDeliveredQty(order, item.itemId) - returnItemReturnedQty(order, item.itemId) - customerReturnPendingQty(order, item.itemId) > 0)) return;
    selectOrderProgressTab('returns');
    orderReturnFormOpen = true;
    document.getElementById('returnCancelEditBtn').style.display = '';
    renderOrderLifecycleModal();
    document.getElementById('returnDate').focus();
};

window.openDeliveryModal = function(orderId) {
    const order = ordersCache.find(item => item.id === orderId);
    if (!order) return;
    if(orderInventorySyncIncomplete(order)){showActionFeedback('這筆訂單庫存尚未同步完成，請先完成或重試同步。','warning');return;}
    currentDeliveryOrderId = orderId;
    currentLifecycleOrderId = orderId;
    orderProgressHistoryExpanded = false;
    orderLifecycleFormOpen = false;
    orderReturnFormOpen = false;
    selectOrderProgressTab('delivery');
    deliveryPartialFormOpen = false;
    document.getElementById('deliveryModalTitle').innerText = `訂單進度：${order.customerName || order.itemName || '訂單'}`;
    document.getElementById('orderLifecycleStatus').value = normalizedOrderStatus(order);
    document.getElementById('orderLifecycleDate').value = order.orderStatusDate || localDateString();
    document.getElementById('orderLifecycleReason').value = order.orderStatusReason || '';
    resetDeliveryForm();
    resetReturnForm();
    renderDeliveryModal();
    renderOrderLifecycleModal();
    window.renderOrderDeliverySettingsButton?.(order);
    document.getElementById('deliveryModalOverlay').classList.add('active');
};

window.closeDeliveryModal = function() {
    currentDeliveryOrderId = null;
    currentLifecycleOrderId = null;
    deliveryPartialFormOpen = false;
    document.getElementById('deliveryModalOverlay').classList.remove('active');
};

window.prepareOrderLifecycle = function(orderId, status) {
    openDeliveryModal(orderId);
    openOrderLifecycleForm();
    if (!orderLifecycleFormOpen) return;
    document.getElementById('orderLifecycleStatus').value = status;
    document.getElementById('orderLifecycleDate').value = localDateString();
    document.getElementById('orderLifecycleReason').value = '';
    onOrderLifecycleStatusChange();
    document.getElementById('orderStatusEditPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('orderLifecycleReason').focus();
};

async function adjustInventoryReservationForLifecycle(transaction, orderId, order, nextStatus, actor, options={}) {
    if(!['normal','cancelled'].includes(nextStatus))throw new Error('不支援的訂單狀態。');
    const items = normalizedOrderItems(order);
    const deliveries = savedDeliveryRecords(order);
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
        const grossDelivered = deliveries
            .filter(row => row.itemId === itemId || (!row.itemId && items.length === 1))
            .reduce((sum, row) => sum + Number(row.qty || 0), 0);
        const returned = savedReturnRecords(order)
            .filter(row => row.itemId === itemId || (!row.itemId && items.length === 1))
            .reduce((sum, row) => sum + Number(row.qty || 0), 0);
        const delivered = Math.max(0, grossDelivered - returned);
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

function confirmOrderCancellation(order) {
        const progress=deliveryProgressInfo(order);
        if(progress.remaining<=0){alert('這筆訂單已無剩餘未送貨數量。已送貨品項請使用退貨流程。');return false;}
        const items=normalizedOrderItems(order);
        const reserved=items.reduce((sum,item)=>sum+Math.max(0,Number(item.reservedQty||0)),0);
        const incoming=items.reduce((sum,item)=>sum+Math.max(0,Number(item.supplyOrderedQty||0)-Number(item.receivedQty||0)),0);
        const documents=[...new Set(items.flatMap(item=>item.purchaseDocumentNos||[]))];
        const action=progress.delivered>0?'取消剩餘未送貨數量':'取消訂單';
        const message=[`${action}：${progress.remaining} 個。`, `釋放庫存預留：${reserved} 個；已到貨的貨仍留在庫存。`,
            incoming>0?`尚有 ${incoming} 個採購未到貨；已建立採購單不會自動取消，請到採購待到貨確認：供應商同意取消，或保留採購轉庫存。`:'',
            documents.length?`關聯採購單：${documents.join('、')}`:'',
            progress.delivered>0?'已送貨與退貨紀錄保留，已送出的貨不會自動退回庫存。':''].filter(Boolean).join('\n\n');
        return confirm(message);
}

window.quickSetOrderLifecycle = async function(orderId, nextStatus) {
    if (!canManageOrderLifecycleCapability() || !canEditPage('orders.list')) { alert('此操作僅限訂單負責業務或管理員。'); return; }
    if (!['normal', 'cancelled'].includes(nextStatus)) return;
    const cachedOrder = ordersCache.find(item => item.id === orderId);
    if (!cachedOrder) return;
    if(cachedOrder.inventoryReservationStatus==='pending'){showActionFeedback('這筆訂單庫存仍在同步，請完成或重試同步後再變更狀態。','warning');return;}
    if (pendingLifecycleOrderIds.has(orderId) || normalizedOrderStatus(cachedOrder) === nextStatus) return;
    if(nextStatus==='cancelled'&&!confirmOrderCancellation(cachedOrder))return;
    const optimisticBefore = {
        orderStatus: cachedOrder.orderStatus,
        orderStatusDate: cachedOrder.orderStatusDate,
        orderStatusReason: cachedOrder.orderStatusReason,
        orderLifecycleHistory: [...(cachedOrder.orderLifecycleHistory || [])]
    };
    const optimisticDate = localDateString();
    const optimisticHistory = {
        action: nextStatus === 'normal' ? 'restore' : 'status_change',
        before: { status: normalizedOrderStatus(cachedOrder), date: cachedOrder.orderStatusDate || '', reason: cachedOrder.orderStatusReason || '' },
        after: { status: nextStatus, date: optimisticDate, reason: '' },
        by: deliveryActor(),
        at: new Date().toISOString()
    };
    cachedOrder.orderStatus = nextStatus;
    cachedOrder.orderStatusDate = optimisticDate;
    cachedOrder.orderStatusReason = '';
    cachedOrder.orderLifecycleHistory = [...optimisticBefore.orderLifecycleHistory, optimisticHistory];
    pendingLifecycleOrderIds.add(orderId);
    renderOrdersList();
    if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
    try {
        let savedOrder;
        await runRoleTransaction(async transaction => {
            const ref = db.collection('orders').doc(orderId);
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists) throw new Error('找不到這筆訂單。');
            const order = snapshot.data();
            const previous = { status: normalizedOrderStatus(order), date: order.orderStatusDate || '', reason: order.orderStatusReason || '' };
            if (previous.status === nextStatus) { savedOrder = order; return; }
            if(nextStatus==='cancelled'&&deliveryProgressInfo(order).remaining<=0)throw new Error('訂單已無剩餘未送貨數量，請重新確認。');
            const date = localDateString();
            const actor = deliveryActor();
            const history = {
                action: nextStatus === 'normal' ? 'restore' : 'status_change',
                before: previous,
                after: { status: nextStatus, date, reason: '' },
                by: actor,
                at: new Date().toISOString()
            };
            const reservationLifecycle=await adjustInventoryReservationForLifecycle(transaction, orderId, order, nextStatus, actor);
            const updates = {
                items:reservationLifecycle?.items||order.items||[],
                itemCount:(reservationLifecycle?.items||normalizedOrderItems(order)).length,
                orderSchemaVersion:2,
                status: nextStatus === 'cancelled' ? BUSINESS_STATUS.CANCELLED : BUSINESS_STATUS.ACTIVE,
                orderStatus: nextStatus,
                orderStatusDate: date,
                orderStatusReason: '',
                updatedAt: history.at,
                orderLifecycleHistory: firebase.firestore.FieldValue.arrayUnion(history)
            };
            Object.assign(updates,orderWorkIndexFields({...order,...updates}));
            transaction.update(ref, updates);
            savedOrder = { ...order, ...updates, orderLifecycleHistory: [...(order.orderLifecycleHistory || []), history] };
        });
        // The lifecycle transaction already synchronizes stock and purchase demand.
        normalizedOrderItems(savedOrder).forEach(item=>{
            const productKey=inventoryProductKey(item);
            const warehouseId=(item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP'?'':(item.warehouseId||savedOrder.warehouseId||'');
            if(productKey&&warehouseId) invalidateWarehouseStockCache(productKey,warehouseId);
        });
        const index = ordersCache.findIndex(item => item.id === orderId);
        const syncedOrder = { id: orderId, ...savedOrder };
        if (index >= 0) ordersCache[index] = syncedOrder;
        syncOrderIntoPurchasingCaches(syncedOrder);
        writeAppDataCache('orders', ordersCache);
        pendingLifecycleOrderIds.delete(orderId);
        renderOrdersList();
        if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
    } catch (err) {
        Object.assign(cachedOrder, optimisticBefore);
        pendingLifecycleOrderIds.delete(orderId);
        renderOrdersList();
        if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
        alert(`${nextStatus === 'normal' ? '恢復' : '取消'}訂單失敗：` + err.message);
    }
};

window.toggleOrderProgressStatus = function(field, newValue) {
    const orderId = currentDeliveryOrderId;
    if (!orderId || !canManageOrderLifecycleCapability() || !canEditPage('orders.list')) return;
    toggleOrderStatus(orderId, field, newValue);
    renderDeliveryModal();
};

window.resetDeliveryForm = function() {
    deliveryPartialFormOpen = false;
    document.getElementById('deliveryFormPanel').style.display = 'none';
    document.getElementById('deliveryEditId').value = '';
    document.getElementById('deliveryDate').value = localDateString();
    document.getElementById('deliveryQty').value = '';
    document.getElementById('deliveryNotes').value = '';
    document.getElementById('deliveryFormTitle').innerText = '新增送貨紀錄';
    document.getElementById('deliveryCancelEditBtn').style.display = 'none';
    const itemSelect=document.getElementById('deliveryItemId');
    if(itemSelect)itemSelect.disabled=false;
    const order = ordersCache.find(item => item.id === currentDeliveryOrderId);
    const progress = deliveryProgressInfo(order || {});
    document.getElementById('deliveryFormHint').innerText = `目前最多還可登錄 ${progress.remaining} 個。`;
};

window.openPartialDeliveryForm = function() {
    const order = ordersCache.find(item => item.id === currentDeliveryOrderId);
    if (!order || !canManageOrderLifecycleCapability() || !canEditPage('orders.list')) return;
    if (normalizedOrderStatus(order) !== 'normal') { alert('已取消的訂單不能新增送貨紀錄。'); return; }
    const progress = deliveryProgressInfo(order);
    if (progress.remaining <= 0) { alert('這筆訂單已全數送貨。'); return; }
    selectOrderProgressTab('delivery');
    deliveryPartialFormOpen = true;
    document.getElementById('deliveryFormPanel').style.display = '';
    document.getElementById('deliveryQty').value = '';
    document.getElementById('deliveryDate').focus();
};

window.openPartialDeliveryForOrder = function(orderId) {
    if (!canManageOrderLifecycleCapability()) return;
    openDeliveryModal(orderId);
    openPartialDeliveryForm();
};

window.openReturnManagement = function(orderId) {
    if (!canManageOrderLifecycleCapability()) return;
    openDeliveryModal(orderId);
    openReturnForm();
    if (!orderReturnFormOpen) return;
    const form = document.getElementById('returnFormPanel');
    form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    document.getElementById('returnDate').focus();
};

window.openOrderStatusHistory = function(orderId) {
    const order = ordersCache.find(item => item.id === orderId);
    if (!order) return;
    currentOrderHistoryId = orderId;
    orderProgressHistoryExpanded = false;
    document.getElementById('orderHistoryModalTitle').innerText = `操作紀錄：${order.orderNo || order.customerName || '訂單'}`;
    renderOrderStatusHistory(order);
    document.getElementById('orderHistoryModalOverlay').classList.add('active');
};
window.closeOrderStatusHistory = function() {
    currentOrderHistoryId = null;
    document.getElementById('orderHistoryModalOverlay').classList.remove('active');
};

function renderOrderStatusHistory(order) {
    const tbody = document.getElementById('orderStatusHistoryBody');
    if (!tbody) return;
    const entries = [];
    const createdAt=order.createdAt||order.orderDate||'';
    if(createdAt){
        entries.push({
            at:createdAt,
            action:'建立訂單',
            by:order.createdByName||order.createdBy||order.creatorName||order.salesName||'',
            detail:[order.orderNo||order.id||'',order.customerName||''].filter(Boolean).join('｜')
        });
    }
    normalizedOrderItems(order).forEach(item=>{
        const itemLabel=[item.itemCode||'',item.itemName||''].filter(Boolean).join(' ');
        const orderEvents=Array.isArray(item.orderEvents)?item.orderEvents:[];
        orderEvents.forEach(event=>{
            const action=event.type==='SALES_SELF_ORDER'?'業務自行訂貨':'已採購';
            const detail=[itemLabel,event.documentNo||'',event.qty!=null?(`數量 ${event.qty}`):''].filter(Boolean).join('｜');
            entries.push({at:event.at||event.date||item.orderedAt||'',action,by:event.by||'',detail});
        });
        // 已有 orderedAt 的既有資料仍可顯示一筆採購時間，不要求回補歷史事件。
        if(!orderEvents.length&&item.orderedAt&&Number(item.supplyOrderedQty||0)>0){
            const documentNos=[...(item.purchaseDocumentNos||[]),...(item.manualOrderNos||[]),...(item.selfOrderNos||[])].filter(Boolean);
            entries.push({at:item.orderedAt,action:(item.procurementType||'')==='SALES_SELF_ORDER'?'業務自行訂貨':'已採購',by:'',detail:[itemLabel,documentNos.join('、'),`累計 ${Number(item.supplyOrderedQty||0)}`].filter(Boolean).join('｜')});
        }
        (item.receiptEvents||[]).forEach(event=>{
            const action=event.fulfillmentType==='DIRECT_SHIP'?'原廠直送到貨':'採購入庫';
            const detail=[itemLabel,event.qty!=null?(`到貨 ${event.qty}`):'',event.sourceOrderStatus==='cancelled'?'來源訂單已取消，轉自由庫存':''].filter(Boolean).join('｜');
            entries.push({at:event.at||event.date||'',action,by:event.by||'',detail});
        });
    });
    (order.statusHistory || []).forEach(item => entries.push({ at: item.at, action: item.label || '進度變更', by: item.by, detail: '' }));
    (order.deliveryHistory || []).forEach(item => {
        const action = { create: '新增送貨', edit: '修改送貨', delete: '刪除送貨', cancel_all: '取消全部送貨', clear_legacy_estimate: '取消歷史推估' }[item.action] || '送貨異動';
        const record = item.after || item.before || {};
        const detail = record.qty != null ? `${record.date || ''}／${record.qty} 個${record.notes ? `／${record.notes}` : ''}` : '';
        entries.push({ at: item.at, action, by: item.by, detail });
    });
    (order.returnHistory || []).forEach(item => {
        const action = { create: '新增退貨', edit: '修改退貨', delete: '刪除退貨' }[item.action] || '退貨異動';
        const record = item.after || item.before || {};
        entries.push({ at: item.at, action, by: item.by, detail: `${record.date || ''}${record.qty != null ? `／${record.qty} 個` : ''}${record.reason ? `／${record.reason}` : ''}` });
    });
    const deliveryHistoryRecordIds=new Set((order.deliveryHistory||[]).flatMap(item=>[item.after?.id,item.before?.id]).filter(Boolean));
    savedDeliveryRecords(order).forEach(record=>{
        if(record.id&&deliveryHistoryRecordIds.has(record.id))return;
        entries.push({at:record.createdAt||record.date||'',action:'送貨紀錄',by:record.createdBy||'',detail:`${record.date||''}${record.qty!=null?`／${record.qty} 個`:''}${record.notes?`／${record.notes}`:''}`});
    });
    const returnHistoryRecordIds=new Set((order.returnHistory||[]).flatMap(item=>[item.after?.id,item.before?.id]).filter(Boolean));
    savedReturnRecords(order).forEach(record=>{
        if(record.id&&returnHistoryRecordIds.has(record.id))return;
        entries.push({at:record.createdAt||record.date||'',action:'退貨紀錄',by:record.createdBy||'',detail:`${record.date||''}${record.qty!=null?`／${record.qty} 個`:''}${record.reason?`／${record.reason}`:''}`});
    });
    (order.orderLifecycleHistory || []).forEach(item => {
        const statusLabels = { normal: '恢復正常', cancelled: '取消訂單', voided: '取消訂單' };
        const after = item.after || {};
        entries.push({ at: item.at, action: statusLabels[after.status] || '訂單狀態變更', by: item.by, detail: `${after.date || ''}${after.reason ? `／${after.reason}` : ''}` });
    });
    (order.fieldEditHistory || []).forEach(item => entries.push({ at: item.at, action: item.label || '修改資料', by: item.by, detail: `${item.before ?? '－'} → ${item.after ?? '－'}` }));
    // 採購／到貨狀態由 supplyOrders、receipts、reservation 與 dispatch qty 推導。
    if (order.isBilled && !(order.statusHistory || []).some(item => item.field === 'isBilled')) {
        entries.push({ at: orderBillingDate(order) || order.orderDate || '', action: '核銷（歷史推估）', by: '舊資料未記錄', detail: '依目前核銷狀態推估' });
    }
    if (order.isDelivered && !savedDeliveryRecords(order).length && !(order.deliveryHistory || []).length) {
        entries.push({ at: order.orderDate || '', action: '送貨（歷史推估）', by: '舊資料未記錄', detail: '依目前訂單狀態推估，日期暫用訂單日期' });
    }
    for(const h of order.logisticsHistory||[])entries.push({at:h.at,action:h.action,by:h.by,detail:h.detail||''});
    entries.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    tbody.innerHTML = entries.length ? (orderProgressHistoryExpanded ? entries : entries.slice(0, 5)).map(item => `<tr><td>${escapeHtml(formatOrderStatusTime(item.at))}</td><td>${escapeHtml(item.action || '')}</td><td>${escapeHtml(item.by || '')}</td><td>${escapeHtml(item.detail || '')}</td></tr>`).join('') : '<tr><td colspan="4" style="color:#888;">尚無操作紀錄。</td></tr>';
    document.getElementById('orderHistoryMoreBtn').hidden = orderProgressHistoryExpanded || entries.length <= 5;
    labelOrderProgressRecords('orderStatusHistoryBody', ['時間', '動作', '操作人', '說明']);
}

async function applyInventoryDeliveryDeltaInTransaction(transaction, order, deltaQty, actor, sourceId, reversalRecords) {
    if(order.transferPendingId)throw new Error('此品項尚在倉庫調撥途中，請目的倉先確認收貨。');
    const deliveryPlan=globalThis.YushinWarehouseLogistics?.plan(order.deliveryPlan||order.shippingInstructions||{});
    if(deltaQty>0&&(order.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP'&&deliveryPlan?.mode==='PICKUP'&&order.warehouseId&&order.warehouseId!==defaultWarehouse()?.id&&!String(order.warehouseId).startsWith('custody-'))throw new Error('主倉自領品項仍在分倉，請先完成調回主倉與收貨。');
    if(deltaQty>0&&globalThis.YushinWarehouseLogistics?.businessDeliveryState&&typeof canReceiveInventoryCapability==='function'&&!canReceiveInventoryCapability()){
        const state=globalThis.YushinWarehouseLogistics.businessDeliveryState(order,order,{shippable:deltaQty},defaultWarehouse()?.id||'');
        if(!state.shippable)throw new Error(state.deliveryWait+'，目前不能登錄已送貨。');
    }
    if (!deltaQty || (order.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP') return { reservedDelta:0,newReservedQty:Math.max(0,Number(order.reservedQty||0)),lotAllocations:[],cogs:0 };
    const productKey = inventoryProductKey(order);
    const warehouseId = order.warehouseId || defaultWarehouse()?.id || '';
    const invRef = inventoryRefFor(order);
    const whRef = warehouseId ? db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,productKey)) : null;
    if (!invRef || !whRef) throw new Error('此訂單尚未指定有效倉庫，無法進行庫存出貨。');

    const deliveryItemId=String(order.itemId||'').trim();
    if(!deliveryItemId) throw new Error('出貨品項缺少 itemId，無法安全對應庫存預留紀錄。');
    const deliveryReservationRef=db.collection('inventoryReservations').doc(`${sourceId}__${deliveryItemId}`);
    const invSnap = await transaction.get(invRef);
    const whSnap = await transaction.get(whRef);
    const reservationSnap = await transaction.get(deliveryReservationRef);
    if (!whSnap.exists) throw new Error('指定倉庫沒有這個產品的分倉庫存，請先入庫或以庫存調整建立分倉數量。');

    const inv = inventoryNumbers(invSnap.exists ? invSnap.data() : {}), wh = inventoryNumbers(whSnap.data());
    const currentReservation=Math.max(0,Number(reservationSnap.exists?reservationSnap.data().quantity:0));
    const newReservedRemaining=Math.max(0,currentReservation-deltaQty);
    const reservedDelta=newReservedRemaining-currentReservation;
    const now = new Date().toISOString();
    let lotAllocations=[],cogs=0;

    if (deltaQty > 0) {
        if (order.requireStockReservation === true && (!invSnap.exists || inv.onHand < deltaQty || inv.reserved < deltaQty || wh.reserved < deltaQty || currentReservation < deltaQty)) throw new Error('庫存或訂單預留數量不足，請先確認庫存資料後再出貨。');
        if (wh.onHand < deltaQty) throw new Error(`庫存不足：${warehouseMasterCache.find(w=>w.id===warehouseId)?.warehouseName || warehouseId} 現有 ${wh.onHand}，本次需出貨 ${deltaQty}。`);
        // Web Firestore transactions accept document references, not queries.
        // Discover IDs, then re-read every candidate in the transaction so concurrent
        // delivery/receipt changes force a retry before any stock is written.
        const lotQuery=await db.collection('inventoryLots').where('productKey','==',productKey).where('warehouseId','==',warehouseId).where('remainingQty','>',0).get();
        const lotSnapshots=await Promise.all(lotQuery.docs.map(doc=>transaction.get(doc.ref)));
        const lotDocs=lotSnapshots.filter(doc=>doc.exists).map(doc=>({id:doc.id,...doc.data()}))
            .filter(l=>l.productKey===productKey&&l.warehouseId===warehouseId&&Number(l.remainingQty||0)>0);
        if(!lotDocs.length)throw new Error('此庫存尚未建立批次成本資料，請先完成入庫／期初庫存批次建檔後再送貨。');
        const allocation=globalThis.YushinInventory.allocateLots(lotDocs.map(lot=>({...lot,unitCost:0})),deltaQty);
        lotAllocations=allocation.allocations;cogs=allocation.totalCost;
        lotAllocations.forEach(row=>{
            const lot=lotDocs.find(x=>x.id===row.lotId);
            transaction.update(db.collection('inventoryLots').doc(row.lotId),{remainingQty:Number(lot.remainingQty||0)-row.qty,updatedAt:now});
        });
    } else {
        const restoreQty=Math.abs(deltaQty);
        const sourceRecords=Array.isArray(reversalRecords)&&reversalRecords.length?reversalRecords:savedDeliveryRecords(order);
        const reversal=globalThis.YushinInventory.reverseLotAllocations(sourceRecords,restoreQty);
        lotAllocations=reversal.allocations.map(row=>({...row,qty:-row.qty,cost:-row.cost}));
        const lotContexts=await Promise.all(reversal.allocations.map(async row=>{
            const lotRef=db.collection('inventoryLots').doc(row.lotId);
            return {row,lotRef,lotSnap:await transaction.get(lotRef)};
        }));
        for(const {row,lotRef,lotSnap} of lotContexts){
            if(!lotSnap.exists)throw new Error(`找不到原出貨批次 ${row.lotNo||row.lotId}，無法安全還原庫存。`);
            transaction.update(lotRef,{remainingQty:Number(lotSnap.data().remainingQty||0)+row.qty,updatedAt:now});
        }
        cogs=-reversal.totalCost;
    }

    if (invSnap.exists) transaction.set(invRef,{onHand:Math.max(0,inv.onHand-deltaQty),reserved:Math.max(0,inv.reserved+reservedDelta),incoming:inv.incoming,updatedAt:now},{merge:true});
    transaction.set(whRef,{warehouseId,productKey,onHand:wh.onHand-deltaQty,reserved:Math.max(0,wh.reserved+reservedDelta),incoming:wh.incoming,updatedAt:now},{merge:true});
    const movementRef=db.collection('inventoryMovements').doc();
    transaction.set(movementRef,inventoryMovementRecord(deltaQty>0?'ship':'ship_reversal',-deltaQty,sourceId,productKey,actor,{
        warehouseId,itemId:deliveryItemId,fulfillmentType:'WAREHOUSE',reservedDelta,lotAllocations,costPending:true,
        warehouseStockId:whRef.id,inventoryDocId:invRef.id,
        ownerUid:order.ownerUid||'',salesCode:order.salesCode||''
    }));

    transaction.set(deliveryReservationRef,{...inventoryReservationPayload(sourceId,order,newReservedRemaining,newReservedRemaining>0?'active':'fulfilled'),itemId:deliveryItemId,warehouseId},{merge:true});
    return { reservedDelta,newReservedQty:newReservedRemaining,lotAllocations,cogs,movementId:movementRef.id };
}
function applyInventoryDeliveryInTransaction(transaction, orderRef, order, deliveryQty, actor, sourceId) {
    return applyInventoryDeliveryDeltaInTransaction(transaction, order, deliveryQty, actor, sourceId);
}

async function applyInventoryReturnDeltaInTransaction(transaction, order, deltaQty, actor, sourceId, previousReturnRecord) {
    if (!deltaQty || (order.fulfillmentType || 'WAREHOUSE') === 'DIRECT_SHIP') return {lotAllocations:[],cogs:0};
    const productKey = inventoryProductKey(order);
    const warehouseId = order.warehouseId || defaultWarehouse()?.id || '';
    const invRef = inventoryRefFor(order);
    const whRef = warehouseId ? db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,productKey)) : null;
    if (!invRef || !whRef) throw new Error('此訂單沒有可追蹤的出貨倉庫。');
    const deliveryItemId=String(order.itemId||'').trim();
    if(!deliveryItemId) throw new Error('退貨品項缺少 itemId，無法安全對應庫存預留紀錄。');
    const reservationRef=db.collection('inventoryReservations').doc(`${sourceId}__${deliveryItemId}`);
    const invSnap = await transaction.get(invRef);
    const whSnap = await transaction.get(whRef);
    const reservationSnap = await transaction.get(reservationRef);
    if (!whSnap.exists) throw new Error('找不到原出貨倉庫庫存。');
    const inv=inventoryNumbers(invSnap.exists?invSnap.data():{}), wh=inventoryNumbers(whSnap.data());
    if (deltaQty < 0 && wh.onHand < Math.abs(deltaQty)) {
        throw new Error('刪除／縮減退貨後會造成庫存小於 0。');
    }
    const now=new Date().toISOString();
    let lotAllocations=[],cogs=0;
    if(deltaQty>0){
        // Editing a return increases only the new delta; its original lots are already returned.
        const priorReturns = savedReturnRecords(order).filter(record => !previousReturnRecord || record.id !== previousReturnRecord.id);
        if (previousReturnRecord) priorReturns.push(previousReturnRecord);
        const available=globalThis.YushinInventory.availableReturnAllocations(savedDeliveryRecords(order),priorReturns);
        const plan=globalThis.YushinInventory.reverseLotAllocations([{qty:available.reduce((sum,row)=>sum+Number(row.qty||0),0),lotAllocations:available}],deltaQty);
        lotAllocations=plan.allocations;cogs=plan.totalCost;
        const lotContexts=await Promise.all(lotAllocations.map(async row=>{
            const lotRef=db.collection('inventoryLots').doc(row.lotId);
            return {row,lotRef,lotSnap:await transaction.get(lotRef)};
        }));
        for(const {row,lotRef,lotSnap} of lotContexts){
            if(!lotSnap.exists)throw new Error(`找不到原出貨批次 ${row.lotNo||row.lotId}，無法辦理退貨。`);
            transaction.update(lotRef,{remainingQty:Number(lotSnap.data().remainingQty||0)+row.qty,updatedAt:now});
        }
    }else{
        const plan=globalThis.YushinInventory.reverseLotAllocations(previousReturnRecord?[previousReturnRecord]:[],Math.abs(deltaQty));
        lotAllocations=plan.allocations.map(row=>({...row,qty:-row.qty,cost:-row.cost}));cogs=-plan.totalCost;
        const lotContexts=await Promise.all(plan.allocations.map(async row=>{
            const lotRef=db.collection('inventoryLots').doc(row.lotId);
            return {row,lotRef,lotSnap:await transaction.get(lotRef)};
        }));
        for(const {row,lotRef,lotSnap} of lotContexts){
            if(!lotSnap.exists||Number(lotSnap.data().remainingQty||0)<row.qty)throw new Error(`批次 ${row.lotNo||row.lotId} 庫存不足，無法刪除／縮減退貨。`);
            transaction.update(lotRef,{remainingQty:Number(lotSnap.data().remainingQty||0)-row.qty,updatedAt:now});
        }
    }
    // 正常訂單退貨後要把商品重新保留給原訂單，供補送使用。
    // 已取消／作廢訂單只把退貨放回自由庫存，不能重新占住庫存；若遇到殘留預留也一併釋放。
    const currentReservation=Math.max(0,Number(reservationSnap.exists?reservationSnap.data().quantity:0));
    const returnKeepsReservation=normalizedOrderStatus(order)==='normal';
    const nextReservation=returnKeepsReservation?(order.customerReturnSettlement==='CLOSE'?currentReservation:Math.max(0,currentReservation+deltaQty)):0;
    const reservationDelta=nextReservation-currentReservation;
    const nextReserved=Math.max(0,inv.reserved+reservationDelta);
    const nextWarehouseReserved=Math.max(0,wh.reserved+reservationDelta);
    if (invSnap.exists) transaction.set(invRef,{onHand:Math.max(0,inv.onHand+deltaQty),reserved:nextReserved,incoming:inv.incoming,updatedAt:now},{merge:true});
    transaction.set(whRef,{warehouseId,productKey,onHand:wh.onHand+deltaQty,reserved:nextWarehouseReserved,incoming:wh.incoming,updatedAt:now},{merge:true});
    const reservationStatus=returnKeepsReservation?(nextReservation>0?'active':'fulfilled'):'released';
    transaction.set(reservationRef,{...inventoryReservationPayload(sourceId,order,nextReservation,reservationStatus),itemId:deliveryItemId,warehouseId},{merge:true});
    transaction.set(db.collection('inventoryMovements').doc(),{
        type:deltaQty>0?'return_in':'return_reversal',qty:deltaQty,productKey,warehouseId,
        fulfillmentType:'WAREHOUSE',sourceType:DOCUMENT_TYPES.ORDER,sourceId,
        createdAt:now,createdBy:actor,lotAllocations,costPending:true,reservationDelta,
        ownerUid:order.ownerUid||'',salesCode:order.salesCode||''
    });
    return {lotAllocations,cogs,reservationDelta,newReservedQty:nextReservation};
}

window.quickCompleteDelivery = async function(orderIdOverride) {
    const orderId = orderIdOverride || currentDeliveryOrderId;
    const cachedOrder = ordersCache.find(item => item.id === orderId);
    if (!cachedOrder || !canManageOrderLifecycleCapability() || !canEditPage('orders.list')) return;
    if(orderInventorySyncIncomplete(cachedOrder)){showActionFeedback('訂單庫存尚未同步完成，請先完成同步。','warning');return;}
    const cachedProgress = deliveryProgressInfo(cachedOrder);
    if (normalizedOrderStatus(cachedOrder) !== 'normal') { alert('已取消的訂單不能送貨。'); return; }
    if (cachedProgress.state === 'complete') return quickCancelAllDelivery(orderId);
    if (cachedProgress.remaining <= 0) return;
    const fulfillment=fulfillmentProgressInfo(cachedOrder);
    const allItems=normalizedOrderItems(cachedOrder);
    const warehouseItems=allItems.filter(item=>(item.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP');
    if (allItems.length > 1) {
        alert('多品項訂單請逐品項登錄送貨，確保送貨與退貨都能追蹤到正確品項。');
        openDeliveryModal(orderId);
        openPartialDeliveryForm();
        return;
    }
    if (warehouseItems.length && fulfillment.shippable < cachedProgress.remaining) {
        alert(fulfillment.shippable > 0
            ? `目前只有 ${fulfillment.shippable} 個已完成打單可出貨，請使用分批送貨。`
            : '目前尚未完成打單，不能送貨。');
        if (fulfillment.shippable > 0) { openDeliveryModal(orderId); openPartialDeliveryForm(); }
        return;
    }
    const today = localDateString();
    const optimisticBefore = {
        deliveryRecords: savedDeliveryRecords(cachedOrder).slice(), deliveredQty: cachedOrder.deliveredQty,
        isDelivered: cachedOrder.isDelivered, statusHistory: [...(cachedOrder.statusHistory || [])]
    };
    const optimisticActor = deliveryActor();
    const optimisticAt = new Date().toISOString();
    cachedOrder.deliveryRecords = [...optimisticBefore.deliveryRecords, { id: `pending-${Date.now()}`, itemId:allItems[0].itemId, date: today, qty: cachedProgress.remaining, notes: '一鍵完成剩餘送貨', createdBy: optimisticActor, createdAt: optimisticAt }];
    cachedOrder.deliveredQty = cachedProgress.total;
    cachedOrder.isDelivered = true;
    pendingDeliveryOrderIds.add(orderId);
    renderOrdersList();
    if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
    try {
        let savedOrder;
        await runRoleTransaction(async transaction => {
            const ref = db.collection('orders').doc(orderId);
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists) throw new Error('找不到這筆訂單。');
            const order = snapshot.data();
            if (normalizedOrderStatus(order) !== 'normal') throw new Error('這筆訂單已取消。');
            if(orderInventorySyncIncomplete(order))throw new Error('訂單庫存尚未同步完成');
            const transactionItems=normalizedOrderItems(order);
            // UI 已阻擋多品項一鍵送貨；transaction 仍要以最新資料再次驗證，
            // 避免 stale cache 或另一端剛修改品項後寫入無法歸屬品項的送貨紀錄。
            if (transactionItems.length !== 1) throw new Error('多品項訂單不能一鍵完成送貨，請逐品項登錄。');
            if (order.isDelivered && savedDeliveryRecords(order).length === 0) throw new Error('這筆舊資料已視為全數送貨。');
            const total = orderQuantity(order);
            const records = savedDeliveryRecords(order).slice();
            const alreadyDelivered = records.reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
            const alreadyReturned = returnedQuantity(order);
            const effectiveDelivered = Math.max(0, alreadyDelivered - alreadyReturned);
            const remaining = Math.max(0, total - effectiveDelivered);
            if (!total || remaining <= 0) throw new Error('這筆訂單已無尚未送貨數量。');
            const actor = deliveryActor();
            const now = new Date().toISOString();
            const record = { id: deliveryRecordId(), itemId:transactionItems[0].itemId, date: today, qty: remaining, notes: '一鍵完成剩餘送貨', createdBy: actor, createdAt: now };
            records.push(record);
            const history = { action: 'create', source: 'quick_complete', recordId: record.id, before: null, after: record, by: actor, at: now };
            const statusEntries = [];
            const deliveryItem=transactionItems[0];
            const itemOrder={...order,...deliveryItem,deliveryRecords:records.filter(row=>row.itemId===deliveryItem.itemId),isDelivered:false};
            const inventoryResult=await applyInventoryDeliveryInTransaction(transaction, ref, itemOrder, remaining, actor, orderId);
            record.lotAllocations=inventoryResult?.lotAllocations||[];
            record.cogs=Number(inventoryResult?.cogs||0);
            records[records.length-1]=record;
            const nextItems=transactionItems.map((item,index)=>index===0?{...item,reservedQty:Number(inventoryResult?.newReservedQty??item.reservedQty??0)}:item);
            const grossAfterDelivery = records.reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
            const effectiveAfterDelivery = Math.max(0, grossAfterDelivery - returnedQuantity(order));
            const updates = {
                items:nextItems, deliveryRecords: records, deliveredQty: grossAfterDelivery, isDelivered: effectiveAfterDelivery >= total,
                deliveryHistory: firebase.firestore.FieldValue.arrayUnion(history)
            };
            if (statusEntries.length) updates.statusHistory = firebase.firestore.FieldValue.arrayUnion(...statusEntries);
            Object.assign(updates,orderWorkIndexFields({...order,...updates}));
            transaction.update(ref, updates);
            savedOrder = {
                ...order, ...updates,
                deliveryHistory: [...(order.deliveryHistory || []), history],
                statusHistory: [...(order.statusHistory || []), ...statusEntries]
            };
        });
        const index = ordersCache.findIndex(item => item.id === orderId);
        if (index >= 0) ordersCache[index] = { id: orderId, ...savedOrder };
        pendingDeliveryOrderIds.delete(orderId);
        if (currentDeliveryOrderId === orderId) {
            resetDeliveryForm();
            renderDeliveryModal();
            renderOrderLifecycleModal();
        }
        renderOrdersList();
    } catch (err) {
        cachedOrder.deliveryRecords = optimisticBefore.deliveryRecords;
        cachedOrder.deliveredQty = optimisticBefore.deliveredQty;
        cachedOrder.isDelivered = optimisticBefore.isDelivered;
        cachedOrder.statusHistory = optimisticBefore.statusHistory;
        pendingDeliveryOrderIds.delete(orderId);
        renderOrdersList();
        if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
        alert('一鍵送貨失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    }
};

window.quickCancelAllDelivery = async function(orderIdOverride) {
    const orderId = orderIdOverride || currentDeliveryOrderId;
    const cachedOrder = ordersCache.find(item => item.id === orderId);
    if (!cachedOrder || !canManageOrderLifecycleCapability() || !canEditPage('orders.list')) return;
    if (returnedQuantity(cachedOrder) > 0) { alert('這筆訂單已有退貨紀錄，請先從 ⋯ 中更正或刪除退貨紀錄。'); return; }
    if (normalizedOrderItems(cachedOrder).length > 1) {
        alert('舊版多品項訂單不能使用一鍵取消全部送貨，請逐品項更正送貨紀錄，避免庫存還原到錯誤品項。');
        openDeliveryModal(orderId);
        return;
    }
    const optimisticBefore = { deliveryRecords: savedDeliveryRecords(cachedOrder).slice(), deliveredQty: cachedOrder.deliveredQty, isDelivered: cachedOrder.isDelivered };
    cachedOrder.deliveryRecords = [];
    cachedOrder.deliveredQty = 0;
    cachedOrder.isDelivered = false;
    pendingDeliveryOrderIds.add(orderId);
    renderOrdersList();
    if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
    try {
        let savedOrder;
        await runRoleTransaction(async transaction => {
            const ref = db.collection('orders').doc(orderId);
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists) throw new Error('找不到這筆訂單。');
            const order = snapshot.data();
            // 前端雖已擋多品項，但 transaction 必須再次依最新 Firestore 資料驗證，
            // 避免 stale cache／重複操作把整張訂單的庫存還原到錯誤品項。
            if (normalizedOrderItems(order).length !== 1) throw new Error('只有單品項訂單可以一鍵取消全部送貨，請逐品項更正送貨紀錄。');
            if (returnedQuantity(order) > 0) throw new Error('這筆訂單已有退貨紀錄，請先更正退貨紀錄。');
            const progress = deliveryProgressInfo(order);
            if (progress.state !== 'complete') throw new Error('這筆訂單目前不是全數已送貨狀態。');
            const actor = deliveryActor();
            const now = new Date().toISOString();
            const before = savedDeliveryRecords(order).length
                ? { records: savedDeliveryRecords(order), deliveredQty: progress.delivered }
                : { legacyEstimated: true, estimatedDate: order.orderDate || '', deliveredQty: progress.delivered };
            const history = { action: 'cancel_all', source: 'quick_toggle', before, after: { records: [], deliveredQty: 0 }, by: actor, at: now };
            const currentItems=normalizedOrderItems(order);
            const deliveryItem=currentItems[0];
            const itemOrder={...order,...deliveryItem,deliveryRecords:savedDeliveryRecords(order),isDelivered:false};
            const inventoryResult=await applyInventoryDeliveryDeltaInTransaction(transaction, itemOrder, -progress.delivered, actor, orderId, savedDeliveryRecords(order));
            const nextItems=currentItems.map((item,index)=>index===0?{...item,reservedQty:Number(inventoryResult?.newReservedQty??item.reservedQty??0)}:item);
            const updates = { items:nextItems, deliveryRecords: [], deliveredQty: 0, isDelivered: false, deliveryHistory: firebase.firestore.FieldValue.arrayUnion(history), updatedAt: now };
            Object.assign(updates,orderWorkIndexFields({...order,...updates}));
            transaction.update(ref, updates);
            savedOrder = { ...order, ...updates, deliveryHistory: [...(order.deliveryHistory || []), history] };
        });
        const index = ordersCache.findIndex(item => item.id === orderId);
        if (index >= 0) ordersCache[index] = { id: orderId, ...savedOrder };
        pendingDeliveryOrderIds.delete(orderId);
        if (currentDeliveryOrderId === orderId) {
            resetDeliveryForm();
            renderDeliveryModal();
            renderOrderLifecycleModal();
        }
        renderOrdersList();
    } catch (err) {
        cachedOrder.deliveryRecords = optimisticBefore.deliveryRecords;
        cachedOrder.deliveredQty = optimisticBefore.deliveredQty;
        cachedOrder.isDelivered = optimisticBefore.isDelivered;
        pendingDeliveryOrderIds.delete(orderId);
        renderOrdersList();
        if (currentDeliveryOrderId === orderId) { renderDeliveryModal(); renderOrderLifecycleModal(); }
        alert('取消已送貨失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    }
};

function renderDeliveryModal() {
    const order = ordersCache.find(item => item.id === currentDeliveryOrderId);
    if (!order) return;
    const editable = canManageOrderLifecycleCapability() && canEditPage('orders.list');
    const isEditing = !!document.getElementById('deliveryEditId').value;
    document.getElementById('deliveryFormPanel').style.display = editable && (normalizedOrderStatus(order) === 'normal' || isEditing) && (deliveryPartialFormOpen || isEditing) ? '' : 'none';
    const progress = deliveryProgressInfo(order);
    const lifecycle = orderLifecycleInfo(order);
    const locked = lifecycle.status !== 'normal';
    const syncing = pendingDeliveryOrderIds.has(order.id);
    const editableSteps = editable && !locked && !syncing;
    const purchase=purchaseProgressInfo(order);
    const fulfillment=fulfillmentProgressInfo(order);
    document.getElementById('orderWorkflowSteps').innerHTML = `
        <button type="button" class="workflow-step ${['ordered','not_required','direct'].includes(purchase.state)?'done':purchase.state==='partial'?'partial':''}" disabled><span>1</span>${escapeHtml(purchase.label)}</button>
        <button type="button" class="workflow-step ${['ready','direct','complete'].includes(fulfillment.state)?'done':fulfillment.state==='partial'?'partial':''}" disabled><span>2</span>${escapeHtml(fulfillment.label)}</button>
        <button type="button" class="workflow-step ${progress.state==='complete'?'done':progress.state==='partial'?'partial':''}" ${editableSteps&&progress.remaining>0?'onclick="openPartialDeliveryForm()"':'disabled'}><span>3</span>${escapeHtml(progress.label)}</button>
        <button type="button" class="workflow-step ${order.isBilled?'done':''}" ${editableSteps?`onclick="toggleOrderProgressStatus('isBilled', ${!order.isBilled})"`:'disabled'}><span>4</span>${order.isBilled?'已核銷':'未核銷'}</button>`;
    const deliveryItems=normalizedOrderItems(order);
    const deliveryItemNameById=new Map(deliveryItems.map(item=>[item.itemId,item.itemName||item.itemId||'']));
    const itemSummary=deliveryItems.map(item=>{
        const grossDelivered=savedDeliveryRecords(order)
            .filter(r=>(r.itemId||((deliveryItems.length===1&&deliveryItems[0]?.itemId)||''))===item.itemId)
            .reduce((sum,r)=>sum+Number(r.qty||0),0);
        const returned=savedReturnRecords(order)
            .filter(r=>(r.itemId||((deliveryItems.length===1&&deliveryItems[0]?.itemId)||''))===item.itemId)
            .reduce((sum,r)=>sum+Number(r.qty||0),0);
        const delivered=Math.max(0,grossDelivered-returned);
        return `<div><strong>${escapeHtml(item.itemName||'未命名品項')}</strong>（${escapeHtml(item.itemCode||'無貨號')}）<br>訂單數量 ${Number(item.qty||0)}｜已送 ${grossDelivered}｜退貨 ${returned}｜有效已送 ${delivered}</div>`;
    }).join('');
    document.getElementById('deliveryOrderSummary').innerHTML = itemSummary + `
        <div style="margin-top:6px;">目前狀態：${escapeHtml(lifecycle.label)}｜已送 ${progress.delivered}/${progress.total}｜未送 ${progress.remaining}</div>
        ${progress.isLegacyEstimated ? '<br><span class="delivery-estimated">這是舊版「已送貨」資料，日期暫以訂單日期推估。</span>' : ''}`;
    const deliveryForm=document.getElementById('deliveryFormPanel');
    if(deliveryForm&&deliveryItems.length>1){
        let select=document.getElementById('deliveryItemId');
        if(!select){
            select=document.createElement('select');select.id='deliveryItemId';select.style.marginBottom='8px';
            deliveryForm.insertBefore(select,deliveryForm.firstChild);
        }
        const current=select.value;
        select.innerHTML=deliveryItems.map(item=>`<option value="${escapeAttr(item.itemId)}">${escapeHtml(item.itemCode||'')} ${escapeHtml(item.itemName||'')}</option>`).join('');
        if(deliveryItems.some(item=>item.itemId===current))select.value=current;
        select.style.display='';
    }else{
        const select=document.getElementById('deliveryItemId');if(select)select.style.display='none';
    }

    const tbody = document.getElementById('deliveryRecordsBody');
    const partialButton = document.getElementById('openPartialDeliveryBtn');
    if (partialButton) partialButton.style.display = editable && !locked && progress.remaining > 0 ? '' : 'none';
    const records = savedDeliveryRecords(order).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    if (records.length) {
        tbody.innerHTML = records.map(record => `<tr>
            <td>${escapeHtml(record.date || '')}</td><td>${escapeHtml(String(record.qty || ''))}</td>
            <td>${record.itemId ? escapeHtml(deliveryItemNameById.get(record.itemId)||record.itemId)+'<br>' : ''}${escapeHtml(record.notes || '')}</td>
            <td>${escapeHtml(record.createdBy || '')}<br><span style="font-size:10px;color:#666;">${escapeHtml(formatOrderStatusTime(record.createdAt))}</span></td>
            <td>${editable ? `<details class="order-record-actions"><summary>操作</summary><button type="button" class="btn-small btn-secondary" onclick="editDeliveryRecord(${inlineJsValue(record.id)})">編輯</button> <button type="button" class="btn-danger" onclick="deleteDeliveryRecord(${inlineJsValue(record.id)})">更正誤登</button></details>` : '僅可查看'}</td>
        </tr>`).join('');
    } else if (progress.isLegacyEstimated) {
        tbody.innerHTML = `<tr><td>${escapeHtml(order.orderDate || '')}<br><span class="delivery-estimated">歷史推估</span></td><td>${progress.total}</td><td>舊版已送貨資料</td><td>－</td><td>${editable ? '<button type="button" class="btn-secondary" onclick="clearLegacyDelivery()">取消此推估</button>' : '僅可查看'}</td></tr>`;
    } else {
        tbody.innerHTML = '<tr><td colspan="5" style="color:#888;">尚無送貨紀錄。</td></tr>';
    }
    labelOrderProgressRecords('deliveryRecordsBody', ['送貨日期', '數量', '備註', '登錄人／時間', '操作']);
    document.getElementById('deliveryFormHint').innerText = progress.isLegacyEstimated
        ? '請先取消舊資料推估，再登錄正確的分批送貨紀錄。'
        : `目前最多還可登錄 ${progress.remaining} 個。`;
}

window.editDeliveryRecord = function(recordId) {
    const order = ordersCache.find(item => item.id === currentDeliveryOrderId);
    const record = savedDeliveryRecords(order).find(item => item.id === recordId);
    if (!record) return;
    const orderItems=normalizedOrderItems(order);
    const targetItem=orderItems.find(item=>item.itemId===record.itemId) || (orderItems.length===1?orderItems[0]:null);
    if(!targetItem){alert('找不到這筆送貨紀錄對應的品項，無法安全編輯。');return;}
    document.getElementById('deliveryEditId').value = record.id;
    const itemSelect=document.getElementById('deliveryItemId');
    if(itemSelect){
        itemSelect.value=targetItem.itemId;
        itemSelect.disabled=true;
        itemSelect.style.display=orderItems.length>1?'':'none';
    }
    document.getElementById('deliveryDate').value = record.date || localDateString();
    document.getElementById('deliveryQty').value = record.qty;
    document.getElementById('deliveryNotes').value = record.notes || '';
    document.getElementById('deliveryFormTitle').innerText = '編輯送貨紀錄';
    document.getElementById('deliveryCancelEditBtn').style.display = '';
    document.getElementById('deliveryFormPanel').style.display = '';
    const otherDelivered=savedDeliveryRecords(order)
        .filter(row=>row.id!==recordId&&((!row.itemId&&orderItems.length===1)||row.itemId===targetItem.itemId))
        .reduce((sum,row)=>sum+Number(row.qty||0),0);
    const returned=savedReturnRecords(order)
        .filter(row=>((!row.itemId&&orderItems.length===1)||row.itemId===targetItem.itemId))
        .reduce((sum,row)=>sum+Number(row.qty||0),0);
    const otherNetDelivered=Math.max(0,otherDelivered-returned);
    const maxQty=Math.max(0,Number(targetItem.qty||targetItem.orderedQty||0)-otherNetDelivered);
    document.getElementById('deliveryFormHint').innerText = `此筆最多可改為 ${maxQty} 個。`;
};

window.saveDeliveryRecord = async function() {
    if (!canManageOrderLifecycleCapability() || !canEditPage('orders.list')) { alert('此操作僅限訂單負責業務或管理員。'); return; }
    const orderId = currentDeliveryOrderId;
    const date = document.getElementById('deliveryDate').value;
    const qty = parseFloat(document.getElementById('deliveryQty').value);
    const notes = document.getElementById('deliveryNotes').value.trim();
    const editId = document.getElementById('deliveryEditId').value;
    if (!orderId || !date || !Number.isFinite(qty) || qty <= 0) {
        alert('請填寫送貨日期與大於 0 的送貨數量。');
        return;
    }
    if (pendingDeliveryOrderIds.has(orderId)) return;
    const saveButton = document.querySelector('[onclick="saveDeliveryRecord()"]');
    pendingDeliveryOrderIds.add(orderId);
    if (saveButton) { saveButton.disabled = true; saveButton.textContent = '儲存中…'; }
    try {
        let savedOrder;
        await runRoleTransaction(async transaction => {
            const ref = db.collection('orders').doc(orderId);
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists) throw new Error('找不到這筆訂單。');
            const order = snapshot.data();
            if (order.isDelivered && savedDeliveryRecords(order).length === 0) throw new Error('請先取消舊資料的歷史推估送貨紀錄。');
            const records = savedDeliveryRecords(order).slice();
            const existingIndex = records.findIndex(item => item.id === editId);
            if (editId && existingIndex < 0) throw new Error('這筆送貨紀錄已被其他人修改或刪除，請重新開啟後再試。');
            if (normalizedOrderStatus(order) !== 'normal' && existingIndex < 0) throw new Error('已取消的訂單不能新增送貨紀錄。');
            const now = new Date().toISOString();
            const actor = deliveryActor();
            const previous = existingIndex >= 0 ? records[existingIndex] : null;
            const orderItems=normalizedOrderItems(order);
            // Select only the recorded item: never silently substitute the first item.
            const requestedItemId=previous?.itemId||(orderItems.length===1?orderItems[0]?.itemId:document.getElementById('deliveryItemId')?.value)||'';
            const targetItem=orderItems.find(item=>item.itemId===requestedItemId);
            if(!targetItem)throw new Error('找不到指定送貨品項，請重新開啟訂單確認。');
            const itemOtherDelivered=records.filter(r=>r.id!==editId&&((!r.itemId&&orderItems.length===1)||r.itemId===targetItem.itemId)).reduce((s,r)=>s+Number(r.qty||0),0);
            const itemReturned=savedReturnRecords(order).filter(r=>r.settlement!=='CLOSE'&&((!r.itemId&&orderItems.length===1)||r.itemId===targetItem.itemId)).reduce((s,r)=>s+Number(r.qty||0),0);
            // 退貨後補送必須以「有效送貨量」驗證，而不是歷史累計送貨量。
            // 例如訂購10、曾送10、退2，可再補送2；歷史送貨會成為12，但有效送貨仍是10。
            const itemGrossAfter=itemOtherDelivered+qty;
            if(itemGrossAfter+1e-9<itemReturned)throw new Error(`${targetItem.itemName||'品項'} 累計送貨數量不能低於已登錄的退貨數量 ${itemReturned}。`);
            const itemOtherNetDelivered=Math.max(0,itemOtherDelivered-itemReturned);
            if(itemOtherNetDelivered+qty>Number(targetItem.qty||0)+1e-9)throw new Error(`${targetItem.itemName||'品項'} 有效送貨數量將超過訂單數量。`);
            if((targetItem.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP'){
                const preparedQty=Number(targetItem.dispatchPreparedQty||0);
                if(itemOtherNetDelivered+qty>preparedQty+1e-9)throw new Error(`${targetItem.itemName||'品項'} 目前已打單可出貨數量只有 ${Math.max(0,preparedQty-itemOtherNetDelivered)}。`);
            }
            const record = previous
                ? { ...previous, itemId:targetItem.itemId, date, qty, notes, updatedBy: actor, updatedAt: now }
                : { id: deliveryRecordId(), itemId:targetItem.itemId, date, qty, notes, createdBy: actor, createdAt: now };
            if (existingIndex >= 0) records[existingIndex] = record; else records.push(record);
            const totalDelivered = records.reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
            const total = orderQuantity(order);
            if (!total) throw new Error('訂單數量必須大於 0，才能登錄送貨。');
            const closedReturned=savedReturnRecords(order).filter(r=>r.settlement==='CLOSE').reduce((sum,r)=>sum+Number(r.qty||0),0);
            const effectiveTotalDelivered=Math.max(0,totalDelivered-returnedQuantity(order)+closedReturned);
            if (effectiveTotalDelivered > total + 1e-9) throw new Error(`有效送貨數量 ${effectiveTotalDelivered} 超過訂單數量 ${total}。`);
            const alreadyReturned = returnedQuantity(order);
            if (totalDelivered + 1e-9 < alreadyReturned) throw new Error(`累計送貨數量不能低於已登錄的退貨數量 ${alreadyReturned}。`);
            const action = previous ? 'edit' : 'create';
            const history = { action, recordId: record.id, before: previous, after: record, by: actor, at: now };
            const updates = { deliveryRecords: records, deliveredQty: totalDelivered, isDelivered: effectiveTotalDelivered >= total, deliveryHistory: firebase.firestore.FieldValue.arrayUnion(history), updatedAt: now };
            const deliveryDelta = qty - Number(previous?.qty || 0);
            if(deliveryDelta){
                const itemRecords=records.filter(r=>r.itemId===targetItem.itemId);
                const itemOrder={...order,...targetItem,qty:Number(targetItem.qty||0),reservedQty:Number(targetItem.reservedQty||0),deliveryRecords:itemRecords,isDelivered:false};
                const inventoryResult=await applyInventoryDeliveryDeltaInTransaction(transaction,itemOrder,deliveryDelta,actor,orderId,deliveryDelta<0&&previous?[previous]:null);
                const syncedItems=orderItems.map(item=>item.itemId===targetItem.itemId?{...item,reservedQty:Number(inventoryResult?.newReservedQty??item.reservedQty??0)}:item);
                updates.items=syncedItems;
                if(deliveryDelta>0){
                    record.lotAllocations=inventoryResult.lotAllocations||[];
                    record.cogs=Number(inventoryResult.cogs||0);
                    const recordIndex=records.findIndex(r=>r.id===record.id);
                    if(recordIndex>=0)records[recordIndex]=record;
                    updates.deliveryRecords=records;
                } else if(previous){
                    const reversed=(inventoryResult.lotAllocations||[]).map(row=>({...row,qty:Math.abs(Number(row.qty||0))}));
                    record.lotAllocations=window.YushinInventory.allocationsAfterReversal(previous.lotAllocations||[],reversed);
                    record.cogs=record.lotAllocations.reduce((sum,row)=>sum+Number(row.cost??(Number(row.qty||0)*Number(row.unitCost||0))),0);
                    const recordIndex=records.findIndex(r=>r.id===record.id);
                    if(recordIndex>=0)records[recordIndex]=record;
                    updates.deliveryRecords=records;
                }
            }
            Object.assign(updates,orderWorkIndexFields({...order,...updates}));
            transaction.update(ref, updates);
            savedOrder = { ...order, ...updates, deliveryHistory: [...(order.deliveryHistory || []), history] };
        });
        const index = ordersCache.findIndex(item => item.id === orderId);
        if (index >= 0) ordersCache[index] = { id: orderId, ...savedOrder };
        resetDeliveryForm();
        renderDeliveryModal();
        renderOrderLifecycleModal();
        renderOrdersList();
    } catch (err) {
        alert('送貨紀錄儲存失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    } finally {
        pendingDeliveryOrderIds.delete(orderId);
        if (saveButton) { saveButton.disabled = false; saveButton.textContent = '💾 儲存送貨紀錄'; }
    }
};

window.deleteDeliveryRecord = async function(recordId) {
    if (!canManageOrderLifecycleCapability() || !canEditPage('orders.list')) { alert('此操作僅限訂單負責業務或管理員。'); return; }
    const correctionReason = prompt('僅限更正誤登的送貨紀錄，會同步回補原出貨庫存並保留異動軌跡。實際已送出的貨請申請退貨。\n\n請輸入誤登更正原因：');
    if (!correctionReason || !correctionReason.trim()) return;
    const orderId = currentDeliveryOrderId;
    if (!orderId || pendingDeliveryOrderIds.has(orderId)) return;
    pendingDeliveryOrderIds.add(orderId);
    renderOrdersList();
    try {
        let savedOrder;
        await runRoleTransaction(async transaction => {
            const ref = db.collection('orders').doc(orderId);
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists) throw new Error('找不到這筆訂單。');
            const order = snapshot.data();
            const records = savedDeliveryRecords(order);
            const removed = records.find(item => item.id === recordId);
            if (!removed) throw new Error('找不到這筆送貨紀錄。');
            const next = records.filter(item => item.id !== recordId);
            const totalDelivered = next.reduce((sum, item) => sum + (parseFloat(item.qty) || 0), 0);
            const alreadyReturned = returnedQuantity(order);
            if (totalDelivered + 1e-9 < alreadyReturned) throw new Error(`刪除後的送貨數量會低於已登錄的退貨數量 ${alreadyReturned}，請先更正退貨紀錄。`);
            const actor = deliveryActor();
            const now = new Date().toISOString();
            const history = { action: 'delete', recordId, before: removed, after: null, reason: correctionReason.trim(), by: actor, at: now };
            const orderItems=normalizedOrderItems(order);
            const targetItem=orderItems.find(item=>item.itemId===removed.itemId) || (orderItems.length===1?orderItems[0]:null);
            if(!targetItem)throw new Error('找不到原送貨品項，無法安全還原庫存。');
            const itemRecords=records.filter(r=>((!r.itemId&&orderItems.length===1)||r.itemId===targetItem.itemId));
            const itemGrossAfter=itemRecords.filter(r=>r.id!==recordId).reduce((sum,row)=>sum+Number(row.qty||0),0);
            const itemReturned=savedReturnRecords(order)
                .filter(row=>((!row.itemId&&orderItems.length===1)||row.itemId===targetItem.itemId))
                .reduce((sum,row)=>sum+Number(row.qty||0),0);
            if(itemGrossAfter+1e-9<itemReturned)throw new Error(`${targetItem.itemName||'品項'} 刪除後的送貨數量會低於已登錄的退貨數量 ${itemReturned}，請先更正退貨紀錄。`);
            const itemOrder={...order,...targetItem,itemId:targetItem.itemId,qty:Number(targetItem.qty||targetItem.orderedQty||0),reservedQty:Number(targetItem.reservedQty||0),deliveryRecords:itemRecords,isDelivered:false};
            const inventoryResult=await applyInventoryDeliveryDeltaInTransaction(transaction, itemOrder, -Number(removed.qty || 0), actor, orderId, [removed]);
            const syncedItems=orderItems.map(item=>item.itemId===targetItem.itemId?{...item,reservedQty:Number(inventoryResult?.newReservedQty??item.reservedQty??0)}:item);
            const effectiveDelivered=Math.max(0,totalDelivered-returnedQuantity(order));
            const updates = { items:syncedItems, deliveryRecords: next, deliveredQty: totalDelivered, isDelivered: effectiveDelivered >= orderQuantity(order) && orderQuantity(order) > 0, deliveryHistory: firebase.firestore.FieldValue.arrayUnion(history), updatedAt: now };
            Object.assign(updates,orderWorkIndexFields({...order,...updates}));
            transaction.update(ref, updates);
            savedOrder = { ...order, ...updates, deliveryHistory: [...(order.deliveryHistory || []), history] };
        });
        const index = ordersCache.findIndex(item => item.id === orderId);
        if (index >= 0) ordersCache[index] = { id: orderId, ...savedOrder };
        resetDeliveryForm();
        renderDeliveryModal();
        renderOrderLifecycleModal();
        renderOrdersList();
    } catch (err) {
        alert('刪除失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    } finally {
        pendingDeliveryOrderIds.delete(orderId);
        renderOrdersList();
    }
};

window.clearLegacyDelivery = async function() {
    if (!canManageOrderLifecycleCapability() || !canEditPage('orders.list')) { alert('此操作僅限訂單負責業務或管理員。'); return; }
    if (!confirm('確定取消這筆舊資料的「已送貨」推估嗎？取消後請重新登錄正確送貨日期與數量。')) return;
    const order = ordersCache.find(item => item.id === currentDeliveryOrderId);
    if (!order) return;
    if (returnedQuantity(order) > 0) { alert('這筆訂單已有退貨紀錄，請先更正或刪除退貨紀錄。'); return; }
    const now = new Date().toISOString();
    const history = { action: 'clear_legacy_estimate', before: { isDelivered: true, estimatedDate: order.orderDate || '' }, after: null, by: deliveryActor(), at: now };
    try {
        const updates={isDelivered:false,deliveredQty:0,deliveryRecords:[],deliveryHistory:firebase.firestore.FieldValue.arrayUnion(history),updatedAt:now};
        Object.assign(updates,orderWorkIndexFields({...order,...updates}));
        await db.collection('orders').doc(order.id).update(updates);
        order.isDelivered = false;
        order.deliveredQty = 0;
        order.deliveryRecords = [];
        order.deliveryHistory = [...(order.deliveryHistory || []), history];
        resetDeliveryForm();
        renderDeliveryModal();
        renderOrderLifecycleModal();
        renderOrdersList();
    } catch (err) {
        alert('取消歷史推估失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    }
};

function lifecycleRecordId() {
    return deliveryRecordId();
}

window.openOrderLifecycleModal = function(orderId) {
    openDeliveryModal(orderId);
};

window.closeOrderLifecycleModal = function() {
    closeDeliveryModal();
};

window.onOrderLifecycleStatusChange = function() {
    const status = document.getElementById('orderLifecycleStatus').value;
    document.getElementById('orderLifecycleReason').placeholder = status === 'normal' ? '恢復說明（選填）' : '取消原因（選填）';
};

function returnItemDeliveredQty(order,itemId) {
    const items=normalizedOrderItems(order);
    return savedDeliveryRecords(order)
        .filter(record=>(record.itemId||((items.length===1&&items[0]?.itemId)||''))===itemId)
        .reduce((sum,record)=>sum+Number(record.qty||0),0);
}

function returnItemReturnedQty(order,itemId,excludeRecordId='') {
    const items=normalizedOrderItems(order);
    return savedReturnRecords(order)
        .filter(record=>record.id!==excludeRecordId&&(record.itemId||((items.length===1&&items[0]?.itemId)||''))===itemId)
        .reduce((sum,record)=>sum+Number(record.qty||0),0);
}

function populateReturnItemOptions(order,selectedItemId='') {
    const select=document.getElementById('returnItemId');
    if(!select||!order)return;
    const items=normalizedOrderItems(order);
    const options=items.filter(item=>returnItemDeliveredQty(order,item.itemId)>0);
    select.innerHTML=options.map(item=>`<option value="${escapeAttr(item.itemId)}">${escapeHtml(item.itemCode||item.itemName||item.itemId)}｜${escapeHtml(item.itemName||'')}</option>`).join('');
    const preferred=selectedItemId||options[0]?.itemId||'';
    if(preferred&&options.some(item=>item.itemId===preferred))select.value=preferred;
    select.disabled=!!document.getElementById('returnEditId')?.value;
}

window.updateReturnFormHint = function() {
    const order=ordersCache.find(item=>item.id===currentLifecycleOrderId);
    const hint=document.getElementById('returnFormHint');
    if(!order||!hint)return;
    const items=normalizedOrderItems(order);
    const selectedItemId=document.getElementById('returnItemId')?.value||(items.length===1?items[0]?.itemId:'');
    const editId=document.getElementById('returnEditId')?.value||'';
    if(!selectedItemId){hint.innerText='請先選擇要退貨的品項。';return;}
    const item=items.find(row=>row.itemId===selectedItemId);
    const delivered=returnItemDeliveredQty(order,selectedItemId);
    const otherReturned=returnItemReturnedQty(order,selectedItemId,editId);
    hint.innerText=`${item?.itemName||item?.itemCode||'此品項'}目前最多還可登錄 ${Math.max(0,delivered-otherReturned-(typeof customerReturnPendingQty==='function'?customerReturnPendingQty(order,selectedItemId):0))} 個退貨（已扣除待收申請）。`;
};

window.resetReturnForm = function() {
    orderReturnFormOpen = false;
    document.getElementById('returnFormPanel').style.display = 'none';
    document.getElementById('returnEditId').value = '';
    document.getElementById('returnDate').value = localDateString();
    document.getElementById('returnQty').value = '';
    document.getElementById('returnReason').value = '';
    document.getElementById('returnFormTitle').innerText = '新增退貨申請';
    document.getElementById('returnCancelEditBtn').style.display = 'none';
    const order=ordersCache.find(item=>item.id===currentLifecycleOrderId);
    populateReturnItemOptions(order);
    updateReturnFormHint();
};

function renderOrderLifecycleStatusOptions(order) {
    const select = document.getElementById('orderLifecycleStatus');
    const progress = deliveryProgressInfo(order);
    const currentStatus = normalizedOrderStatus(order);
    const selected = select.value || currentStatus;
    const canCancel = progress.remaining > 0;
    const cancelLabel = currentStatus === 'cancelled' ? '已取消'
        : progress.grossDelivered > 0 ? '取消剩餘未送貨數量' : '取消訂單';
    select.innerHTML = '<option value="normal">正常</option>'
        + (canCancel || currentStatus === 'cancelled' ? `<option value="cancelled">${cancelLabel}</option>` : '');
    select.value = selected === 'cancelled' && (canCancel || currentStatus === 'cancelled') ? 'cancelled' : 'normal';
    const hint = document.getElementById('orderLifecycleStatusHint');
    if (hint) hint.innerText = canCancel
        ? (progress.grossDelivered > 0 ? '僅取消剩餘未送貨數量；已送貨部分請申請退貨。' : '')
        : '已無剩餘未送貨數量，不能取消訂單；已送貨部分請申請退貨。';
}

function renderOrderLifecycleModal() {
    const order = ordersCache.find(item => item.id === currentLifecycleOrderId);
    if (!order) return;
    const editable = canManageOrderLifecycleCapability() && canEditPage('orders.list');
    const info = orderLifecycleInfo(order);
    renderOrderLifecycleStatusOptions(order);
    const canCancel = deliveryProgressInfo(order).remaining > 0;
    const cancelled = normalizedOrderStatus(order) !== 'normal';
    document.getElementById('orderStatusEditPanel').style.display = editable && orderLifecycleFormOpen && (canCancel || cancelled) ? '' : 'none';
    const lifecycleButton = document.getElementById('openLifecycleFormBtn');
    lifecycleButton.hidden = !editable || (!canCancel && !cancelled);
    lifecycleButton.textContent = cancelled ? '恢復訂單' : deliveryProgressInfo(order).grossDelivered > 0 ? '取消剩餘未送數量' : '取消訂單';
    const canReturn = normalizedOrderItems(order).some(item => returnItemDeliveredQty(order, item.itemId) - returnItemReturnedQty(order, item.itemId) - customerReturnPendingQty(order, item.itemId) > 0);
    document.getElementById('openReturnFormBtn').hidden = !editable || !canReturn;
    document.getElementById('orderLifecycleActionHint').textContent = !canCancel && !cancelled ? '已無剩餘未送貨數量；退貨請建立申請，由倉庫頁確認實收。' : '取消僅處理未送貨數量；已送貨部分請申請退貨。';
    const isEditingReturn = !!document.getElementById('returnEditId').value;
    document.getElementById('returnFormPanel').style.display = editable && (orderReturnFormOpen || isEditingReturn) && (info.effectiveDelivered > 0 || isEditingReturn) ? '' : 'none';
    const records = savedReturnRecords(order).slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const tbody = document.getElementById('returnRecordsBody');
    tbody.innerHTML = records.length ? records.map(record => `<tr>
        <td>${escapeHtml(record.date || '')}</td><td>${escapeHtml(String(record.qty || ''))}</td><td>${escapeHtml(record.reason || '')}</td>
        <td>${escapeHtml(record.createdBy || '')}<br><span style="font-size:10px;color:#666;">${escapeHtml(formatOrderStatusTime(record.createdAt))}</span></td>
        <td>僅可查看</td>
    </tr>`).join('') : '<tr><td colspan="5" style="color:#888;">尚無退貨紀錄。</td></tr>';
    labelOrderProgressRecords('returnRecordsBody', ['退貨日期', '數量', '原因／備註', '登錄人／時間', '操作']);
    const editingRecord=records.find(record=>record.id===document.getElementById('returnEditId')?.value);
    populateReturnItemOptions(order,editingRecord?.itemId||'');
    updateReturnFormHint();
    onOrderLifecycleStatusChange();
}

window.saveOrderLifecycleStatus = async function() {
    if (!canManageOrderLifecycleCapability() || !canEditPage('orders.list')) { alert('此操作僅限訂單負責業務或管理員。'); return; }
    const order = ordersCache.find(item => item.id === currentLifecycleOrderId);
    if (!order) return;
    const nextStatus = document.getElementById('orderLifecycleStatus').value;
    const date = document.getElementById('orderLifecycleDate').value;
    const reason = document.getElementById('orderLifecycleReason').value.trim();
    if (!date) { alert('請填寫狀態日期。'); return; }
    const previous = { status: normalizedOrderStatus(order), date: order.orderStatusDate || '', reason: order.orderStatusReason || '' };
    if (previous.status === nextStatus && previous.date === date && previous.reason === reason) return;
    if (pendingLifecycleOrderIds.has(order.id)) return;
    if(nextStatus==='cancelled'&&previous.status!=='cancelled'&&!confirmOrderCancellation(order))return;
    const actor = deliveryActor();
    const at = new Date().toISOString();
    const history = { action: nextStatus === 'normal' && previous.status !== 'normal' ? 'restore' : 'status_change', before: previous, after: { status: nextStatus, date, reason }, by: actor, at };
    const saveButton = document.getElementById('orderLifecycleSaveBtn');
    pendingLifecycleOrderIds.add(order.id);
    if (saveButton) { saveButton.disabled = true; saveButton.innerText = '儲存中…'; }
    try {
        let savedOrder;
        await runRoleTransaction(async transaction => {
            const ref = db.collection('orders').doc(order.id);
            const snapshot = await transaction.get(ref);
            if (!snapshot.exists) throw new Error('找不到這筆訂單。');
            const liveOrder = snapshot.data();
            const livePrevious = { status: normalizedOrderStatus(liveOrder), date: liveOrder.orderStatusDate || '', reason: liveOrder.orderStatusReason || '' };
            let reservationLifecycle=null;
            if (livePrevious.status !== nextStatus) {
                if(nextStatus==='cancelled'&&deliveryProgressInfo(liveOrder).remaining<=0)throw new Error('訂單已無剩餘未送貨數量，請重新確認。');
                reservationLifecycle=await adjustInventoryReservationForLifecycle(transaction, order.id, liveOrder, nextStatus, actor);
            }
            const liveHistory = { action: nextStatus === 'normal' && livePrevious.status !== 'normal' ? 'restore' : 'status_change', before: livePrevious, after: { status: nextStatus, date, reason }, by: actor, at };
            const updates = {
                items:reservationLifecycle?.items||liveOrder.items||[],
                itemCount:(reservationLifecycle?.items||normalizedOrderItems(liveOrder)).length,
                orderSchemaVersion:2,
                status: nextStatus === 'cancelled' ? BUSINESS_STATUS.CANCELLED : BUSINESS_STATUS.ACTIVE,
                orderStatus: nextStatus, orderStatusDate: date, orderStatusReason: reason,
                orderLifecycleHistory: firebase.firestore.FieldValue.arrayUnion(liveHistory), updatedAt: at
            };
            Object.assign(updates,orderWorkIndexFields({...liveOrder,...updates}));
            transaction.update(ref, updates);
            savedOrder = { ...liveOrder, ...updates, orderLifecycleHistory: [...(liveOrder.orderLifecycleHistory || []), liveHistory] };
        });
        // The lifecycle transaction already synchronizes stock and purchase demand.
        const index = ordersCache.findIndex(item => item.id === order.id);
        if (index >= 0) ordersCache[index] = { id: order.id, ...savedOrder };
        renderDeliveryModal();
        renderOrderLifecycleModal();
        renderOrdersList();
    } catch (err) {
        alert('訂單狀態儲存失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
    } finally {
        pendingLifecycleOrderIds.delete(order.id);
        if (saveButton) { saveButton.disabled = false; saveButton.innerText = '💾 儲存狀態'; }
    }
};

// Customer return mutations are owned by modules/customer-cancellations.js.

window.updateOrderField = function(orderId, field, value) {
    const o = ordersCache.find(x => x.id === orderId);
    if (!o || !canEditPage('orders.list')) return;
    if (field === 'costPrice' && (o.procurementType || 'PURCHASING_PO') !== 'SALES_SELF_ORDER') {
        alert('公司標準成本請在採購／成本資料維護，不寫入業務可讀的訂單文件。');
        renderOrdersList();
        return;
    }
    const previousValue = o ? o[field] : undefined;
    if (String(previousValue ?? '') === String(value ?? '')) return;
    const labels = { costPrice: '修改單位成本', transactionType: '修改交易方式', invoiceTitle: '修改發票抬頭', remarks: '修改備註' };
    const history = {
        field, label: labels[field] || `修改${field}`,
        before: previousValue ?? '', after: value ?? '',
        by: currentUserName || currentUser?.email || '未知使用者', at: new Date().toISOString()
    };

    o[field] = value;
    o.fieldEditHistory = [...(o.fieldEditHistory || []), history];
    if (field === 'transactionType') renderOrdersList();

    db.collection('orders').doc(orderId).update({ [field]: value, fieldEditHistory: firebase.firestore.FieldValue.arrayUnion(history) }).catch(err => {
        o[field] = previousValue;
        o.fieldEditHistory = (o.fieldEditHistory || []).filter(item => item !== history);
        if (field === 'transactionType') renderOrdersList();
        alert('更新失敗，已還原：' + err.message);
    });
};

window.deleteOrder = function(orderId) {
    if (trueUserRole !== 'admin' || currentUserRole !== 'admin') {
        if (canManageOrderLifecycleCapability()) prepareOrderLifecycle(orderId, 'cancelled');
        else alert('只有管理員可永久刪除訂單。');
        return;
    }
    const order = ordersCache.find(item => item.id === orderId);
    if (!order || !canEditPage('orders.list')) return;
    if (!isDeletableOrderDraft(order)) {
        alert('這筆訂單已有來源或流程紀錄，不能直接刪除，請改用取消。');
        prepareOrderLifecycle(orderId, 'cancelled');
        return;
    }
    if (!confirm('確定要刪除這筆尚未進入流程的草稿訂單嗎？')) return;
    runRoleTransaction(async transaction => {
        const ref = db.collection('orders').doc(orderId);
        const snapshot = await transaction.get(ref);
        if (!snapshot.exists) throw new Error('找不到這筆訂單。');
        if (!isDeletableOrderDraft(snapshot.data())) throw new Error('這筆訂單已有新的流程紀錄，不能刪除，請改用取消。');
        transaction.delete(ref);
    }).then(() => {
        ordersCache = ordersCache.filter(item => item.id !== orderId);
        renderOrdersList();
    }).catch(err => alert('刪除失敗：' + err.message));
};

let newOrderDraftItems = [];
const ORDER_DRAFT_STORAGE_PREFIX = 'order_draft_v2';
let requestedOrderOwnerUid = '';
let orderModalOpenGeneration = 0;

function populateOrderOwnerSelect() {
    const wrap = document.getElementById('orderOwnerWrap');
    const select = document.getElementById('orderOwnerUid');
    if (!wrap || !select) return;
    wrap.style.display = currentUserRole === 'purchaser' ? '' : 'none';
    if (currentUserRole !== 'purchaser') return;
    const salespeople = salesList.filter(isSelectableCommercialOwner);
    select.replaceChildren(new Option('請選擇負責業務', ''));
    salespeople.forEach(person => select.add(new Option(`${person.name}（${person.code}・${ROLE_LABELS[person.role]}）`, person.uid)));
    select.value = salespeople.some(person => person.uid === requestedOrderOwnerUid) ? requestedOrderOwnerUid : '';
}

function orderDraftStorageKey() {
    return `${ORDER_DRAFT_STORAGE_PREFIX}:${currentUser?.uid || 'anonymous'}`;
}

function pendingOrderCreateKey() {
    return `${orderDraftStorageKey()}:pending_order_id`;
}

async function createOrResumeNewOrder(data) {
    const key=pendingOrderCreateKey();
    let orderId=localStorage.getItem(key);
    if(!orderId){
        orderId=db.collection('orders').doc().id;
        // 記下編號後才寫入雲端；斷線後重試仍會指向同一張訂單。
        localStorage.setItem(key,orderId);
    }
    const ref=db.collection('orders').doc(orderId);
    let savedData;
    await runRoleTransaction(async tx=>{
        const snap=await tx.get(ref);
        if(snap.exists){
            savedData=snap.data();
            if(savedData.createdByUid!==currentUser?.uid || savedData.status!==BUSINESS_STATUS.ACTIVE)
                throw new Error('待確認的訂單已由其他流程變更，請先檢查訂單清單。');
        }else{
            tx.set(ref,data);
            savedData=data;
        }
    });
    return {id:orderId,data:savedData};
}

function orderDraftFieldValue(id) {
    return document.getElementById(id)?.value ?? '';
}

function collectOrderDraft() {
    return {
        savedAt:new Date().toISOString(),
        ownerUid:orderDraftFieldValue('orderOwnerUid'),
        date:orderDraftFieldValue('orderDateInput'),customerName:orderDraftFieldValue('orderCustomer'),
        itemCode:orderDraftFieldValue('orderItemCode'),itemName:orderDraftFieldValue('orderItemName'),itemNameEn:orderDraftFieldValue('orderItemNameEn'),productLine:orderDraftFieldValue('orderProductLine'),spec:orderDraftFieldValue('orderSpec'),
        brand:getBrandFieldValue('orderBrand','orderBrandOther'),qty:orderDraftFieldValue('orderQty'),
        supplier:orderDraftFieldValue('orderSelfSupplier'),unitPrice:orderDraftFieldValue('orderUnitPrice'),costPrice:orderDraftFieldValue('orderCostPrice'),
        procurementType:orderDraftFieldValue('orderProcurementType')||'PURCHASING_PO',
        selfOrderConfirmed:orderDraftFieldValue('orderSelfOrderConfirmed')==='confirmed',remarks:orderDraftFieldValue('orderRemarks'),
        fulfillmentType:orderDraftFieldValue('orderFulfillmentType')||'WAREHOUSE',warehouseId:orderDraftFieldValue('orderWarehouse'),
        transactionType:orderDraftFieldValue('orderTransactionType'),invoiceTitle:orderDraftFieldValue('orderInvoiceTitle'),
        productId:window._orderModalProductId||'',items:newOrderDraftItems,
        shippingInstructions:window.orderShippingInstructions?.()||{},
        sourceLink:window._orderModalSourceLink||null,
        quoteContext:window._orderModalQuoteContext||null
    };
}

function readOrderDraft() {
    try {
        const value=JSON.parse(localStorage.getItem(orderDraftStorageKey())||'null');
        return value&&typeof value==='object'?value:null;
    } catch (_) { return null; }
}

function saveOrderDraft() {
    if(restoringOrderDraft||!document.getElementById('orderModalOverlay')?.classList.contains('active'))return;
    try { localStorage.setItem(orderDraftStorageKey(),JSON.stringify(collectOrderDraft())); }
    catch (err) { console.warn('保存訂單重試資料失敗：',err); }
}

function clearSavedOrderDraft(options={}) {
    localStorage.removeItem(orderDraftStorageKey());
    if(options.clearPending) localStorage.removeItem(pendingOrderCreateKey());
}

function setOrderModalItem(item={}) {
    const normalized=normalizeNewOrderItem(item);
    document.getElementById('orderItemCode').value=normalized.itemCode||'';
    document.getElementById('orderItemName').value=normalized.itemName||'';
    const nameEn=document.getElementById('orderItemNameEn');if(nameEn)nameEn.value=normalized.itemNameEn||'';
    const spec=document.getElementById('orderSpec');if(spec)spec.value=normalized.spec||'';
    const productLineField=document.getElementById('orderProductLine');if(productLineField)productLineField.value=normalized.productLine||'';
    const codeInput=document.getElementById('orderItemCode');
    codeInput.dataset.productLine=normalized.productLine||'';
    codeInput.dataset.productType=normalized.productType||'';
    codeInput.dataset.productMasterMatched=normalized.productMasterMatched===true?'1':'0';
    delete codeInput.dataset.autofillBrand;
    codeInput.dataset.matchedProductCode=normalizeItemCodeLoose(normalized.itemCode);
    codeInput.dataset.preserveOrderPriceCode=normalizeItemCodeLoose(normalized.itemCode);
    codeInput.dataset.productCheckStatus=normalized.productCheckStatus||'';
    if(normalized.brand)selectBrandInDropdown(document.getElementById('orderBrand'),normalized.brand);
    else document.getElementById('orderBrand').value='';
    onOrderBrandSelectChange();
    if (normalized.productId) codeInput.dataset.autofillBrand=normalizeBrandLookupKey(resolveBrandName(normalized.brand||''));
    document.getElementById('orderQty').value=normalized.qty||1;
    document.getElementById('orderUnitPrice').value=normalized.unitPrice??'';
    document.getElementById('orderTotalPrice').value=normalized.totalPrice||0;
    const supplierInput=document.getElementById('orderSelfSupplier');if(supplierInput)supplierInput.value=normalized.supplier||'';
    document.getElementById('orderCostPrice').value=normalized.costPrice??'';
    const procurement=document.getElementById('orderProcurementType');if(procurement)procurement.value=normalized.procurementType||'PURCHASING_PO';
    const confirmed=document.getElementById('orderSelfOrderConfirmed');if(confirmed)confirmed.value=normalized.selfOrderConfirmed===true?'confirmed':'pending';
    onOrderProcurementTypeChange();
    if(normalized.procurementType==='SALES_SELF_ORDER')document.getElementById('orderCostPrice').value=normalized.costPrice??'';
    document.getElementById('orderFulfillmentType').value=normalized.fulfillmentType||'WAREHOUSE';
    populateOrderWarehouseOptions(normalized.warehouseId||'');
    onOrderFulfillmentChange();
    if(normalized.deliveryPlan)window.setOrderShippingInstructions?.(normalized.deliveryPlan);
    window.syncOrderEntrySelfStatus?.();
    window._orderModalProductId=normalized.productId||'';
    onOrderItemCodeChange(codeInput);
    refreshOrderWarehouseStock();
}

function restoreSavedOrderDraft(){
    const draft=readOrderDraft();if(!draft)return;
    restoringOrderDraft=true;
    try {
        requestedOrderOwnerUid = draft.ownerUid || '';
        window._orderModalSourceLink = draft.sourceLink || null;
        window._orderModalQuoteContext = draft.quoteContext || null;
        populateOrderOwnerSelect();
        document.getElementById('orderDateInput').value=draft.date||'';
        document.getElementById('orderCustomer').value=draft.customerName||'';
        const remarks=document.getElementById('orderRemarks');if(remarks)remarks.value=draft.remarks||'';
        setOrderModalItem(draft);
        window.setOrderShippingInstructions?.(draft.shippingInstructions||{});
        document.getElementById('orderTransactionType').value=draft.transactionType||'';
        const invoice=document.getElementById('orderInvoiceTitle');invoice.value=draft.invoiceTitle||'';invoice.disabled=draft.transactionType!=='直';
        newOrderDraftItems=Array.isArray(draft.items)?draft.items.map(normalizeNewOrderItem):[];
        renderNewOrderDraftItems();
        checkNewOrderDraftProducts();
        const title=document.getElementById('orderModalTitle');if(title)title.innerText='新增訂單（續傳未完成）';
    } finally { restoringOrderDraft=false; }
}

function updateOrderDraftRecoveryBanner(source = null) {
    const banner = document.getElementById('orderDraftRecoveryBanner');
    const message = document.getElementById('orderDraftRecoveryMessage');
    if (!banner) return;
    const pendingId = localStorage.getItem(pendingOrderCreateKey());
    const draft = pendingId ? readOrderDraft() : null;
    const shouldShow = !source && !!pendingId && !!draft;
    banner.style.display = shouldShow ? '' : 'none';
    if (!shouldShow || !message) return;
    const savedAt = draft.savedAt ? new Date(draft.savedAt) : null;
    const timeText = savedAt && !Number.isNaN(savedAt.getTime())
        ? savedAt.toLocaleString('zh-TW', { hour12:false })
        : '';
    message.textContent = timeText
        ? `發現上次儲存未完成的訂單（${timeText}）。為避免重複下單，請先恢復確認或放棄這次重試。`
        : '發現上次儲存未完成的訂單。為避免重複下單，請先恢復確認或放棄這次重試。';
}

window.restoreSavedOrderDraftFromBanner = function() {
    populateOrderBrandDropdown();
    populateOrderOwnerSelect();
    restoreSavedOrderDraft();
    const banner = document.getElementById('orderDraftRecoveryBanner');
    if (banner) banner.style.display = 'none';
    const draft = readOrderDraft();
    loadWarehouseMaster().then(() => {
        populateOrderWarehouseOptions(draft?.warehouseId || '');
        refreshOrderWarehouseStock();
    }).catch(err => console.warn('恢復訂單草稿時讀取倉庫失敗：', err));
};

window.discardSavedOrderDraftFromBanner = async function() {
    const button = document.getElementById('discardOrderDraftBtn');
    const pendingId = localStorage.getItem(pendingOrderCreateKey());
    if (button) {
        button.disabled = true;
        button.textContent = '確認中…';
    }
    try {
        if (pendingId) {
            const snapshot = await firestoreReadWithTimeout(
                db.collection('orders').doc(pendingId).get(),
                '確認未完成訂單'
            );
            if (snapshot.exists) {
                alert('這筆訂單已經存在雲端，為避免重複下單，系統不會直接清除續傳資料。請先回訂單列表確認該筆訂單。');
                return;
            }
        }
        clearSavedOrderDraft({ clearPending:true });
        updateOrderDraftRecoveryBanner();
        showActionFeedback('未完成訂單重試資料已清除。');
    } catch (err) {
        alert('目前無法確認未完成訂單狀態，為避免資料重複，暫不清除：' + (err?.message || err));
    } finally {
        if (button) {
            button.disabled = false;
            button.textContent = '放棄這次重試';
        }
    }
};

function normalizeNewOrderItem(item = {}) {
    const match=findPriceItemForOrder(item);
    const qty=Math.max(0,Number(item.qty||0));
    const unitPrice=item.unitPrice===null || item.unitPrice===undefined || String(item.unitPrice).trim()==='' ? null : Number(item.unitPrice);
    const productId=String(item.productId||match?.productId||'').trim();
    const brand=resolveBrandName(match?.brand||item.brand||'');
    return {
        ...item,itemId:item.itemId||`item-${Date.now()}-${Math.random().toString(36).slice(2,7)}`,
        itemCode:String(item.itemCode||'').trim(),itemCodeKey:normalizeHistoryItemCode(item.itemCode||''),itemName:String(item.itemName||'').trim(),
        brand,brandId:match?.brandId||item.brandId||brandIdForName(brand),qty,orderedQty:qty,unitPrice,totalPrice:qty*unitPrice,
        productId,productLine:match?.productLine||item.productLine||'',productType:match?.productType||item.productType||'',
        productMasterMatched:!!productId && (!!match || item.productMasterMatched === true),
        supplier:item.supplier||match?.supplier||'',spec:match?.spec||item.spec||'',
        procurementType:item.procurementType||'PURCHASING_PO', fulfillmentType:item.fulfillmentType||'WAREHOUSE',
        warehouseId:(item.fulfillmentType||'WAREHOUSE')==='WAREHOUSE' ? String(item.warehouseId||'') : ''
    };
}

function currentOrderModalItem() {
    const codeInput=document.getElementById('orderItemCode');
    const item={supplier:document.getElementById('orderSelfSupplier')?.value.trim()||'',itemCode:codeInput.value,itemName:document.getElementById('orderItemName').value,itemNameEn:document.getElementById('orderItemNameEn')?.value||'',productLine:codeInput.dataset.productLine||document.getElementById('orderProductLine')?.value||'',productType:codeInput.dataset.productType||'',productMasterMatched:codeInput.dataset.productMasterMatched==='1',productCheckStatus:codeInput.dataset.productCheckStatus||'',spec:document.getElementById('orderSpec')?.value||'',brand:getBrandFieldValue('orderBrand','orderBrandOther'),qty:document.getElementById('orderQty').value,unitPrice:document.getElementById('orderUnitPrice').value,procurementType:document.getElementById('orderProcurementType')?.value||'PURCHASING_PO',fulfillmentType:document.getElementById('orderFulfillmentType')?.value||'WAREHOUSE',warehouseId:document.getElementById('orderWarehouse')?.value||'',productId:window._orderModalProductId||''};
    item.selfOrderConfirmed=document.getElementById('orderSelfOrderConfirmed')?.value==='confirmed';
    item.deliveryPlan=window.orderShippingInstructions?.()||{};
    item.deliveryCustomerName=document.getElementById('orderCustomer')?.value.trim()||'';
    const cost=document.getElementById('orderCostPrice').value;if(item.procurementType==='SALES_SELF_ORDER'&&cost!=='')item.costPrice=Number(cost);
    return normalizeNewOrderItem(item);
}

function orderItemProductStatus(item) {
    if (['checking','error','ambiguous','missing'].includes(item.productCheckStatus)) return item.productCheckStatus;
    return item.productMasterMatched && item.productId ? 'matched' : 'missing';
}
function orderItemProductStatusLabel(item) {
    return {checking:'檢查中…',error:'查詢失敗',ambiguous:'待選擇產品',missing:'未建檔',matched:'已建檔'}[orderItemProductStatus(item)];
}
function renderNewOrderDraftItems(){
    const body=document.getElementById('newOrderItemsBody'),wrap=document.getElementById('newOrderItemsWrap');if(!body||!wrap)return;
    const current=currentOrderModalItem();
    window.refreshOrderEntrySummary?.();
    const currentStatus=document.getElementById('orderProductCheckStatus');
    if(currentStatus) {
        const status=orderItemProductStatus(current);
        currentStatus.innerHTML=current.itemCode ? `<span>${orderItemProductStatusLabel(current)}</span>${status==='error'?`<button type="button" class="btn-small btn-secondary" onclick="onOrderItemCodeChange(document.getElementById('orderItemCode'))">重試</button>`:''}` : '';
    }
    const summary=document.getElementById('orderProductCheckSummary');
    const items=[...newOrderDraftItems,...(current.itemName?[current]:[])];
    const unfinished=items.filter(item=>orderItemProductStatus(item)!=='matched').length;
    if(summary) summary.textContent=items.length ? `共 ${items.length} 個品項，${unfinished ? `${unfinished} 個尚待完成產品檢查或建檔` : '全部已建檔'}` : '';
    wrap.style.display=newOrderDraftItems.length?'':'none';
    body.innerHTML=newOrderDraftItems.map((item,index)=>{
        const status=orderItemProductStatus(item);
        const action=status==='missing'?`<button type="button" class="btn-small btn-secondary" onclick="quickCreateNewOrderDraftItem(${index})">快速建立</button>`
            : ['ambiguous','error'].includes(status)?`<button type="button" class="btn-small btn-secondary" onclick="editNewOrderDraftItem(${index})">${status==='error'?'重試':'選擇產品'}</button>`:'';
        return `<tr><td data-th="貨號">${escapeHtml(item.itemCode||'')}</td><td data-th="品名">${escapeHtml(item.itemName||'')}</td><td data-th="廠牌">${escapeHtml(item.brand||'')}</td><td data-th="數量">${item.qty}</td><td data-th="單價">${item.unitPrice===null?'待確認':Number(item.unitPrice).toLocaleString()}</td><td data-th="產品狀態" class="order-product-status" data-status="${status}">${orderItemProductStatusLabel(item)}</td><td data-th="訂貨／交付">${item.procurementType==='SALES_SELF_ORDER'?(item.selfOrderConfirmed?'自行訂貨・已下訂':'自行訂貨・尚未下訂'):'交由採購'}／${globalThis.YushinOrderEntry.deliveryLabel(item)}</td><td data-th="操作">${action}<button type="button" class="btn-small btn-secondary" onclick="editNewOrderDraftItem(${index})">編輯</button> <button type="button" class="btn-danger btn-small" onclick="removeNewOrderDraftItem(${index})">移除</button></td></tr>`;
    }).join('');
}
let orderDraftProductCheckGeneration=0;
async function checkNewOrderDraftProducts() {
    const generation=++orderDraftProductCheckGeneration;
    const opening=orderModalOpenGeneration;
    const items=[...newOrderDraftItems];
    items.forEach(item=>{item.productCheckStatus='checking';});
    renderNewOrderDraftItems();
    // Exact code queries use the shared cache; repeated codes in the quote share one read.
    for(const item of items) {
        const code=item.itemCode,brand=item.brand;
        try {
            const matches=await findProductsByCode(code,{throwOnError:true});
            if(opening!==orderModalOpenGeneration||generation!==orderDraftProductCheckGeneration) return;
            if(!newOrderDraftItems.includes(item)||item.itemCode!==code||item.brand!==brand) continue;
            const match=selectProductCodeMatch(matches,brand);
            if(match) Object.assign(item,{productId:match.productId||stableProductId(match),productMasterMatched:true,
                brandId:match.brandId||item.brandId,productLine:match.productLine||item.productLine,productType:match.productType||item.productType,productCheckStatus:'matched'});
            else Object.assign(item,{productId:'',productMasterMatched:false,productCheckStatus:!brand&&matches.length>1?'ambiguous':'missing'});
        } catch(err) {
            if(opening!==orderModalOpenGeneration||generation!==orderDraftProductCheckGeneration) return;
            if(newOrderDraftItems.includes(item)&&item.itemCode===code&&item.brand===brand) item.productCheckStatus='error';
        }
        renderNewOrderDraftItems();
    }
}
window.quickCreateNewOrderDraftItem=function(index){
    editNewOrderDraftItem(index);
    const input=document.getElementById('orderItemCode');
    if(input?.value.trim()) openQuickProductCreate('order',input);
};

window.editNewOrderDraftItem=function(index){
    const item=newOrderDraftItems[index];
    if(!item)return;
    const current=currentOrderModalItem();
    if(current.itemName)newOrderDraftItems[index]=current;else newOrderDraftItems.splice(index,1);
    setOrderModalItem(item);
    renderNewOrderDraftItems();
    checkNewOrderDraftProducts();
};
window.removeNewOrderDraftItem=function(index){newOrderDraftItems.splice(index,1);renderNewOrderDraftItems();};
window.addCurrentOrderItemToDraft=function(){
    const item=currentOrderModalItem();
    const validation=globalThis.YushinOrderEntry.validateItem(item);
    if(!validation.valid){alert(validation.message);document.getElementById(validation.field)?.focus();return;}
    try { globalThis.YushinWarehouseLogistics.validatePlan(item.deliveryPlan,true); } catch(err) { alert(err.message); const details=document.getElementById('orderRecipientDetails');if(details)details.open=true;return; }
    if(!item.itemName||item.qty<=0){alert('請先完成目前品項的品名與數量。');return;}
    if(item.productMasterMatched!==true||!item.productId||orderItemProductStatus(item)!=='matched'){alert('正式訂單品項必須先對應產品主檔。請輸入既有貨號，或使用「快速新增產品」完成基本產品資料。');return;}
    const duplicateIndex=newOrderDraftItems.findIndex(existing=>globalThis.YushinOrderEntry.sameDraftItem(existing,item));
    if(duplicateIndex>=0){newOrderDraftItems[duplicateIndex]={...newOrderDraftItems[duplicateIndex],qty:Number(newOrderDraftItems[duplicateIndex].qty||0)+Number(item.qty||0)};newOrderDraftItems[duplicateIndex].totalPrice=Number(newOrderDraftItems[duplicateIndex].qty||0)*Number(newOrderDraftItems[duplicateIndex].unitPrice||0);}
    else newOrderDraftItems.push(item);renderNewOrderDraftItems();
    ['orderItemCode','orderItemName','orderItemNameEn','orderProductLine','orderSpec'].forEach(id=>{const el=document.getElementById(id);if(el)el.value='';});
    const nextCodeInput=document.getElementById('orderItemCode');
    if(nextCodeInput.dataset.autofillBrand){document.getElementById('orderBrand').value='';onOrderBrandSelectChange();}
    const nextSelfStatus=document.getElementById('orderSelfOrderConfirmed');if(nextSelfStatus)nextSelfStatus.value='pending';
    for(const id of ['orderSelfSupplier','orderCostPrice']){const field=document.getElementById(id);if(field){field.value='';delete field.dataset.autofillCost;}}
    window.syncOrderEntrySelfStatus?.();
    delete nextCodeInput.dataset.productLine;delete nextCodeInput.dataset.productType;delete nextCodeInput.dataset.productMasterMatched;delete nextCodeInput.dataset.productCheckStatus;delete nextCodeInput.dataset.preserveOrderPriceCode;delete nextCodeInput.dataset.matchedProductCode;delete nextCodeInput.dataset.autofillBrand;
    clearQuickProductButton(nextCodeInput);clearProductMatchChoices(nextCodeInput);
    renderNewOrderDraftItems();
    document.getElementById('orderQty').value=1;document.getElementById('orderUnitPrice').value='';document.getElementById('orderTotalPrice').value=0;window._orderModalProductId='';
};

window.openOrderModal = function(source = null) {
    const overlay = document.getElementById('orderModalOverlay');
    if (!overlay) return;
    const openingGeneration = ++orderModalOpenGeneration;
    const openingCode=document.getElementById('orderItemCode');
    if(openingCode){delete openingCode.dataset.matchedProductCode;delete openingCode.dataset.autofillBrand;delete openingCode.dataset.productCheckStatus;delete openingCode.dataset.preserveOrderPriceCode;clearQuickProductButton(openingCode);clearProductMatchChoices(openingCode);}
    const recoveryBanner = document.getElementById('orderDraftRecoveryBanner');
    if (recoveryBanner) recoveryBanner.style.display = 'none';

    // 第一階段只做輕量欄位重設並立即顯示；主檔與輔助清單延後到首幀之後。
    overlay.classList.add('active');
    requestedOrderOwnerUid = source?.ownerUid || '';
    newOrderDraftItems = [];
    renderNewOrderDraftItems();

    window.setOrderShippingInstructions?.(source?.shippingInstructions||{});
    const title = document.getElementById('orderModalTitle');
    if (title) title.innerText = source?.sourceType === DOCUMENT_TYPES.FORECAST ? 'Forecast 轉訂單' : '新增訂單';
    const today = new Date();
    document.getElementById('orderDateInput').value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    ['orderCustomer', 'orderBrand', 'orderBrandOther', 'orderItemCode', 'orderItemName', 'orderItemNameEn', 'orderProductLine', 'orderSpec', 'orderInvoiceTitle'].forEach(id => {
        const field = document.getElementById(id);
        if (field) field.value = '';
    });
    onOrderBrandSelectChange();
    const selfStatus=document.getElementById('orderSelfOrderConfirmed');if(selfStatus)selfStatus.value=source?.selfOrderConfirmed===true?'confirmed':'pending';
    window.syncOrderEntrySelfStatus?.();
    const productDetails=document.getElementById('orderProductDetails');if(productDetails)productDetails.open=false;
    const recipientDetails=document.getElementById('orderRecipientDetails');if(recipientDetails)recipientDetails.open=false;
    const remarks=document.getElementById('orderRemarks');if(remarks)remarks.value=source?.remarks||'';
    document.getElementById('orderQty').value = 1;
    document.getElementById('orderUnitPrice').value = '';
    document.getElementById('orderTotalPrice').value = 0;
    const supplierInput=document.getElementById('orderSelfSupplier');if(supplierInput)supplierInput.value=source?.supplier||'';
    document.getElementById('orderCostPrice').value = '';
    delete document.getElementById('orderCostPrice').dataset.autofillCost;
    const procurement = document.getElementById('orderProcurementType');
    if (procurement) procurement.value = source?.procurementType || 'PURCHASING_PO';
    onOrderProcurementTypeChange();
    document.getElementById('orderFulfillmentType').value = source?.fulfillmentType || 'WAREHOUSE';
    document.getElementById('orderWarehouse').value = source?.warehouseId || '';
    onOrderFulfillmentChange();
    document.getElementById('orderTransactionType').value = '';
    document.getElementById('orderInvoiceTitle').disabled = true;
    window._orderModalSourceLink = source?.sourceType && source?.sourceId
        ? { sourceType: source.sourceType, sourceId: source.sourceId }
        : null;
    window._orderModalProductId = source?.productId || '';

    if (source) {
        document.getElementById('orderCustomer').value = source.customerName || '';
        const codeInput = document.getElementById('orderItemCode');
        codeInput.value = source.itemCode || '';
        codeInput.dataset.productLine = source.productLine || '';
        codeInput.dataset.productType = source.productType || '';
        codeInput.dataset.matchedProductCode=normalizeItemCodeLoose(source.itemCode||'');
        if (source.productId) codeInput.dataset.autofillBrand=normalizeBrandLookupKey(resolveBrandName(source.brand||''));
        codeInput.dataset.preserveOrderPriceCode=normalizeItemCodeLoose(source.itemCode||'');
        codeInput.dataset.productCheckStatus='checking';
        codeInput.dataset.productMasterMatched = (source.productMasterMatched === true || !!source.productId) ? '1' : '0';
        document.getElementById('orderItemName').value = source.itemName || '';
        const nameEn = document.getElementById('orderItemNameEn');
        if (nameEn) nameEn.value = source.itemNameEn || source.nameEn || '';
        const spec = document.getElementById('orderSpec');
        if (spec) spec.value = source.spec || source.specification || '';
        document.getElementById('orderProductLine').value = source.productLine || '';
        document.getElementById('orderQty').value = source.qty || 1;
        document.getElementById('orderUnitPrice').value = source.unitPrice ?? '';
        if (currentUserRole === 'admin' || currentUserRole === 'purchaser') {
            document.getElementById('orderCostPrice').value = source.costPrice ?? '';
        }
        const total = source.totalPrice !== undefined && source.totalPrice !== null && source.totalPrice !== ''
            ? source.totalPrice
            : (Number(source.qty || 1) * Number(source.unitPrice || 0));
        document.getElementById('orderTotalPrice').value = total || 0;
    }

    deferUntilAfterPaint(async () => {
        if (openingGeneration !== orderModalOpenGeneration || !overlay.classList.contains('active')) return;

        populateOrderOwnerSelect();
        window.initializeOrderDeliveryDefaults?.(source?.shippingInstructions);
        if (currentUserRole === 'purchaser') {
            ensureSalesListLoaded()
                .then(() => {
                    if (openingGeneration === orderModalOpenGeneration) {populateOrderOwnerSelect();window.initializeOrderDeliveryDefaults?.(source?.shippingInstructions);}
                })
                .catch(err => console.error('讀取負責業務名單失敗：', err));
        }

        populateOrderBrandDropdown();
        if (source?.brand) {
            selectBrandInDropdown(document.getElementById('orderBrand'), source.brand);
            onOrderBrandSelectChange();
        }
        populateOrderCustomerSuggestions();
        updateOrderDraftRecoveryBanner(source);
        if(source?.itemCode && document.getElementById('orderItemCode').value===source.itemCode) onOrderItemCodeChange(document.getElementById('orderItemCode'));
        checkNewOrderDraftProducts();

        try {
            await loadWarehouseMaster();
            if (openingGeneration !== orderModalOpenGeneration || !overlay.classList.contains('active')) return;
            populateOrderWarehouseOptions(source?.warehouseId || '');
            if (source?.fulfillmentType === 'WAREHOUSE' && source?.warehouseId) {
                const warehouse = document.getElementById('orderWarehouse');
                if (warehouse) warehouse.value = source.warehouseId;
            }
            refreshOrderWarehouseStock();
            window.initializeOrderDeliveryDefaults?.(source?.shippingInstructions);
        } catch (err) {
            console.warn('新增訂單：倉庫主檔載入失敗，先保留目前表單。', err);
        }

        if (openingGeneration !== orderModalOpenGeneration || !overlay.classList.contains('active')) return;
    }, '新增訂單背景初始化');
};

let customerMasterSuggestionTimer = null;
let customerMasterSuggestionResults = [];

window.queueCustomerMasterSuggestions = function(value) {
    clearTimeout(customerMasterSuggestionTimer);
    const raw = String(value || '').trim();
    if (raw.length < 2) {
        customerMasterSuggestionResults = [];
        populateOrderCustomerSuggestions();
        return;
    }
    customerMasterSuggestionTimer = scheduleListSearch(customerMasterSuggestionTimer, () => searchCustomerMasterSuggestions(raw));
};

async function searchCustomerMasterSuggestions(raw) {
    const keyword = String(raw || '').trim();
    if (keyword.length < 2) return;
    try {
        // Customer Master 的 document id 由標準化客戶名稱產生，因此可用 documentId 前綴查詢，
        // 不需要為了自動完成載入整個 customers collection。
        const prefix = customerIdForName(keyword);
        const snapshot = await firestoreReadWithTimeout(
            db.collection('customers')
                .orderBy(firebase.firestore.FieldPath.documentId())
                .startAt(prefix)
                .endAt(prefix + '\uf8ff')
                .limit(20)
                .get(),
            '客戶主檔建議'
        );
        // 使用者可能在等待期間繼續輸入；舊查詢結果不可覆蓋新的關鍵字。
        const currentValues = [
            document.getElementById('orderCustomer')?.value,
            document.getElementById('eqCustomer')?.value
        ].map(value => String(value || '').trim());
        if (!currentValues.includes(keyword)) return;
        customerMasterSuggestionResults = snapshot.docs
            .map(doc => ({ id: doc.id, ...doc.data() }))
            .filter(item => item.active !== false && item.name)
            .map(item => item.name)
            .slice(0, 20);
        populateOrderCustomerSuggestions();
    } catch (err) {
        console.warn('客戶主檔建議查詢失敗：', err);
    }
}

function populateOrderCustomerSuggestions() {
    const list = document.getElementById('orderCustomerSuggestions');
    if (!list) return;
    const customersByKey = new Map();
    // 空白欄位只提供少量近期候選；完整客戶資料由輸入 2 個字後查 Customer Master。
    // 這樣歷史訂單／估價／儀器增加後，開啟表單不會為了 datalist 掃完整快取與整份 DOM。
    const names = [
        ...getRecentCustomerNames(),
        ...customerMasterSuggestionResults,
        ...ordersCache.slice(0, 20).map(order => order.customerName),
        ...equipmentList.slice(0, 20).map(equipment => equipment.customerName),
        ...myQuotesCache.slice(0, 20).map(quote => quote.clientName),
        ...myQuotesCache.slice(0, 20).map(quote => quote.ordererName)
    ];
    names.forEach(value => {
        const name = String(value || '').trim();
        if (!name) return;
        const key = name.normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase();
        if (!customersByKey.has(key)) customersByKey.set(key, name);
    });
    list.innerHTML = '';
    [...customersByKey.values()].forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            list.appendChild(option);
        });
}

const RECENT_CUSTOMERS_STORAGE_KEY = 'recent_customer_names_v1';

function customerNameKey(value) {
    return String(value || '').trim().normalize('NFKC').replace(/\s+/g, ' ').toLocaleLowerCase();
}

function getRecentCustomerNames() {
    try {
        const saved = JSON.parse(localStorage.getItem(RECENT_CUSTOMERS_STORAGE_KEY) || '[]');
        return Array.isArray(saved) ? saved.map(value => String(value || '').trim()).filter(Boolean).slice(0, 20) : [];
    } catch (_) {
        return [];
    }
}

function rememberRecentCustomerName(value) {
    const name = String(value || '').trim();
    if (!name) return;
    const key = customerNameKey(name);
    const recent = getRecentCustomerNames().filter(item => customerNameKey(item) !== key);
    localStorage.setItem(RECENT_CUSTOMERS_STORAGE_KEY, JSON.stringify([name, ...recent].slice(0, 20)));
    populateOrderCustomerSuggestions();
}

window.copyOrderAsNew = function(orderId) {
    const source = ordersCache.find(order => order.id === orderId);
    if (!source) {
        alert('找不到要複製的訂單，請重新整理後再試。');
        return;
    }
    openOrderModal();
    if (currentUserRole === 'purchaser') {
        requestedOrderOwnerUid = source.ownerUid || '';
        populateOrderOwnerSelect();
    }
    const title = document.getElementById('orderModalTitle');
    if (title) title.innerText = '複製成新訂單';
    document.getElementById('orderCustomer').value = source.customerName || '';
    const copiedItems=normalizedOrderItems(source).map(item=>normalizeNewOrderItem(globalThis.YushinOrderEntry.copyItem(item,source.shippingInstructions)));
    const first=copiedItems[0]||normalizeNewOrderItem(source);
    // 複製訂單要沿用正式的品項填入流程，才能保留 Product Master 身分、
    // 訂貨方式、倉庫與品項屬性；不可只複製畫面文字後再依目前快取猜產品。
    setOrderModalItem(first);
    newOrderDraftItems=copiedItems.slice(1);renderNewOrderDraftItems();
    const transactionType = source.transactionType || '';
    document.getElementById('orderTransactionType').value = transactionType;
    const invoiceInput = document.getElementById('orderInvoiceTitle');
    invoiceInput.value = source.invoiceTitle || '';
    invoiceInput.disabled = transactionType !== '直';
};

window.closeOrderModal = function(options = {}) {
    orderModalOpenGeneration++;
    document.getElementById('orderModalOverlay').classList.remove('active');
    if (!options.preserveSource) {
        window._orderModalSourceLink = null;
        window._orderModalQuoteContext = null;
        window._orderModalProductId = '';
    }
};

window.calcOrderTotal = function() {
    const qty = parseFloat(document.getElementById('orderQty').value) || 0;
    const price = parseFloat(document.getElementById('orderUnitPrice').value) || 0;
    document.getElementById('orderTotalPrice').value = (qty * price).toFixed(0);
};

let newOrderSaveInProgress = false;

let actionFeedbackTimer = null;
function showActionFeedback(message, type = 'success') {
    let status = document.getElementById('actionFeedback');
    if (!status) {
        status = document.createElement('div');
        status.id = 'actionFeedback';
        status.setAttribute('role', 'status');
        document.body.appendChild(status);
    }
    status.className = `action-feedback ${type === 'warning' ? 'warning' : 'success'}`;
    status.textContent = message;
    status.hidden = false;
    clearTimeout(actionFeedbackTimer);
    actionFeedbackTimer = setTimeout(() => { status.hidden = true; }, 6000);
}

window.saveNewOrder = function() {
    if (newOrderSaveInProgress) return;
    const currentItem=currentOrderModalItem();
    const items=[...newOrderDraftItems,...(currentItem.itemName?[currentItem]:[])].map(item=>({...item}));
    if(!items.length){alert('請至少輸入一個訂單品項。');return;}
    try { assertOrderItemCount(items); } catch (err) { alert(err.message); return; }
    if(items.some(item=>!item.itemName||Number(item.qty||0)<=0)){alert('每個品項都必須有品名及大於 0 的數量。');return;}
    const unfinished=items.map((item,index)=>({item,index})).filter(({item})=>item.productMasterMatched!==true||!item.productId||orderItemProductStatus(item)!=='matched');
    if(unfinished.length){
        alert('以下品項尚未完成產品檢查或建檔：\n'+unfinished.map(({item,index})=>`第 ${index+1} 項 ${item.itemCode||item.itemName}（${orderItemProductStatusLabel(item)}）`).join('\n')+'\n請先完成，再儲存訂單。');
        const first=unfinished[0];if(first.index<newOrderDraftItems.length)editNewOrderDraftItem(first.index);
        document.getElementById('orderItemCode')?.scrollIntoView({block:'center',behavior:'smooth'});
        document.getElementById('orderItemCode')?.focus();
        return;
    }
    if(items.some(item=>item.fulfillmentType==='WAREHOUSE'&&warehouseMasterCache.length&&!item.warehouseId)){alert('請為每個倉庫出貨品項選擇倉庫。');return;}
    const assistedOwner = currentUserRole === 'purchaser'
        ? salesList.find(person => person.uid === document.getElementById('orderOwnerUid')?.value
            && isSelectableCommercialOwner(person))
        : null;
    if (currentUserRole === 'purchaser' && !assistedOwner) { alert('請先選擇有效的負責業務。'); return; }
    if(currentUserRole==='purchaser'&&items.some(item=>item.procurementType==='SALES_SELF_ORDER'&&item.selfOrderConfirmed===true)){alert('採購可代建自行訂貨訂單；已向供應商下訂由負責業務確認。');return;}
    if(!document.getElementById('orderCustomer').value.trim()){alert('請填寫客戶名稱。');document.getElementById('orderCustomer')?.focus();return;}
    for(let index=0;index<items.length;index++) {
        const validation=globalThis.YushinOrderEntry.validateItem(items[index]);
        if(!validation.valid){alert(`第 ${index+1} 項：${validation.message}`);if(index<newOrderDraftItems.length)editNewOrderDraftItem(index);document.getElementById(validation.field)?.focus();return;}
    }
    let shippingInstructions;
    try {
        const fallback=window.orderShippingInstructions?.()||{};
        for(const item of items) {
            const plan=item.deliveryPlan||fallback;
            if(plan.mode==='CUSTOMER_SHIP'&&item.deliveryCustomerName&&item.deliveryCustomerName!==document.getElementById('orderCustomer').value.trim())throw new Error('客戶已更換，請編輯各品項並重新確認收件資訊。');
            if(item.fulfillmentType==='DIRECT_SHIP'&&plan.mode!=='CUSTOMER_SHIP')throw new Error('原廠直送請設定客戶收件資訊。');
            item.deliveryPlan=globalThis.YushinWarehouseLogistics.validatePlan(plan,true);
        }
        shippingInstructions=items[0].deliveryPlan;
    } catch(err) {alert(err.message);const details=document.getElementById('orderRecipientDetails');if(details)details.open=true;return;}
    items.forEach(item=>{delete item.productCheckStatus;});
    const firstItem=items[0];
    const itemCode = firstItem.itemCode;
    let data = {
        shippingInstructions:shippingInstructions||{},
        orderDate: document.getElementById('orderDateInput').value,
        createdAt: new Date().toISOString(),
        ...commercialCreatorFields(),
        company: window._orderModalQuoteContext?.company || '',
        customerName: document.getElementById('orderCustomer').value.trim(),
        remarks:document.getElementById('orderRemarks')?.value.trim()||'',
        customerId: customerIdForName(document.getElementById('orderCustomer').value.trim()),
        brand: firstItem.brand,
        brandId: firstItem.brandId || brandIdForName(firstItem.brand),
        itemCode: itemCode,
        itemCodeKey: normalizeHistoryItemCode(itemCode),
        itemName: firstItem.itemName,
        productLine: firstItem.productLine || '',
        productType: '',
        selfOrderAtCreation:true,
        procurementType:firstItem.procurementType||'PURCHASING_PO',
        fulfillmentType:firstItem.fulfillmentType,warehouseId:firstItem.warehouseId||'',qty:firstItem.qty,unitPrice:firstItem.unitPrice,
        totalPrice:items.reduce((sum,item)=>sum+Number(item.totalPrice||0),0),items,itemCount:items.length,orderSchemaVersion:2,
        productMasterMatched:items.length > 0 && items.every(item => item.productMasterMatched === true),
        status: BUSINESS_STATUS.ACTIVE,
        ...grossAmountMetadata(items.reduce((sum,item)=>sum+Number(item.totalPrice||0),0)),
        transactionType: document.getElementById('orderTransactionType').value,
        invoiceTitle: document.getElementById('orderInvoiceTitle').value.trim(),
        quoteNo: window._orderModalQuoteContext?.quoteNo || '',
        ...linkedDocumentFields(window._orderModalSourceLink?.sourceType || '', window._orderModalSourceLink?.sourceId || '', window._orderModalSourceLink ? [documentLink(window._orderModalSourceLink.sourceType, window._orderModalSourceLink.sourceId, 'source')] : []),
        productId: firstItem.productId || '',
        salesName: assistedOwner?.name || window._orderModalQuoteContext?.salesName || currentUserName || '',
        salesCode: assistedOwner?.code || window._orderModalQuoteContext?.salesCode || currentUserCode || '',
        ownerUid: assistedOwner?.uid || window._orderModalQuoteContext?.ownerUid || currentUser?.uid || '',
        isDelivered: false,
        isBilled: false,
        billingDate: ''
    };
    if (firstItem.procurementType === 'SALES_SELF_ORDER'
        && firstItem.costPrice !== undefined && firstItem.costPrice !== null
        && String(firstItem.costPrice).trim() !== '') {
        data.costPrice = Number(firstItem.costPrice);
        data.costSource = hasBusinessCapability()
            ? 'business_manual_transaction_cost'
            : 'manual_transaction_cost';
    }

    if (!data.orderDate || !data.itemName) {
        alert('請至少填寫訂單日期與品名');
        return;
    }
    if (data.fulfillmentType === 'WAREHOUSE' && warehouseMasterCache.length && !data.warehouseId) {
        alert('請選擇出貨倉庫；若由原廠直接送客戶，請改選「原廠直送客戶」。');
        return;
    }
    if (document.getElementById('orderBrand').value === '其他' && !data.brand) {
        alert('已選擇「其他」廠牌，請輸入廠牌名稱');
        return;
    }

    data.customerId = syncCustomerMaster(data.customerName, { salesCode: data.salesCode });
    const priceMatch = findPriceItemForOrder(data);
    data.productLine = firstItem.productLine || (priceMatch && priceMatch.productLine) || '';
    data.productType = (priceMatch && priceMatch.productType) || '';
    if (priceMatch) {
        data.productId = priceMatch.productId || stableProductId(priceMatch);
        data.supplier = priceMatch.supplier || '';
        data.spec = priceMatch.spec || '';
    }
    ensureOrderItemCompatibility(data);
    data.searchTokens = buildFullHistorySearchTokens('order', data);
    data.inventoryReservationStatus = 'pending';
    data.inventoryReservationUpdatedAt = new Date().toISOString();
    if([DOCUMENT_TYPES.QUOTE,DOCUMENT_TYPES.FORECAST].includes(data.sourceType)&&data.sourceId){
        data.sourceDocumentSyncStatus='pending';
        data.sourceDocumentSyncError='';
        data.sourceDocumentSyncUpdatedAt=data.inventoryReservationUpdatedAt;
    }

    const saveButton = document.getElementById('saveNewOrderBtn');
    const savingGeneration=orderModalOpenGeneration;
    const savingUid=currentUser?.uid;
    const savedDraftKey=orderDraftStorageKey();
    const savedPendingKey=pendingOrderCreateKey();
    saveOrderDraft();
    newOrderSaveInProgress = true;
    if (saveButton) { saveButton.disabled = true; saveButton.innerText = '建立中…'; }
    let createdOrderId = '';
    return createOrResumeNewOrder(data).then(async docRef => {
        createdOrderId = docRef.id;
        data=docRef.data;
        newOrderSaveInProgress=false;
        if(saveButton){saveButton.disabled=false;saveButton.innerText='建立訂單';}
        // 正式文件確認寫入後即釋放表單；庫存與來源文件同步使用這份獨立快照。
        pendingOrderReservationIds.add(docRef.id);
        if(currentUser?.uid===savingUid){
            rememberRecentCustomerName(data.customerName);
            const savedOrder = { id:docRef.id, ...data };
            ordersCache = [savedOrder, ...ordersCache.filter(order=>order.id!==docRef.id)]
                .sort((a,b)=>(b.orderDate||'').localeCompare(a.orderDate||''));
            writeAppDataCache('orders',ordersCache);
            renderOrdersList();
            if(localStorage.getItem(savedPendingKey)===docRef.id)localStorage.removeItem(savedPendingKey);
            if(savingGeneration===orderModalOpenGeneration){
                localStorage.removeItem(savedDraftKey);
                closeOrderModal();
            }
            showActionFeedback('訂單已建立，庫存正在背景同步；可繼續建立其他訂單。','success');
        }
        let reservation;
        try {
            if(currentUser?.uid!==savingUid)throw new Error('登入身份已變更，請以原帳號重試同步');
            if(data.inventoryReservationStatus==='completed'){
                reservation=orderReservationSummary(data);
            }else{
                reservation = await synchronizeOrderInventory(docRef.id, data, savingUid);
            }
        } catch (reservationErr) {
            throw new Error(`訂單已建立，但庫存預留未完成：${reservationErr?.message||reservationErr}。請從訂單清單重試同步，勿重複建立。`);
        }
        data.inventoryProductKey = inventoryProductKey(data);
        rememberRecentCustomerName(data.customerName);
        const quoteSyncError=await syncNewOrderSourceDocuments(docRef.id,data,savingUid);
        pendingOrderReservationIds.delete(docRef.id);
        if(currentUser?.uid!==savingUid)return;
        // 單筆回填已完成的庫存資料，不重新查詢整份清單，也不碰下一張訂單的表單。
        const savedOrder = { id: docRef.id, ...data };
        ordersCache = [savedOrder, ...ordersCache.filter(order => order.id !== docRef.id)]
            .sort((a, b) => (b.orderDate || '').localeCompare(a.orderDate || ''));
        writeAppDataCache('orders', ordersCache);
        renderOrdersList();
        syncOrderIntoPurchasingCaches(savedOrder);
        if (quoteSyncError) {
            showActionFeedback('訂單已建立，庫存預留已同步，但來源估價單未標記成交。請勿重複建立訂單，請檢查來源估價單：' + quoteSyncError.message,'warning');
        } else {
            const automaticallyOrdered = Array.isArray(data.items) && data.items.some(item=>
                item.procurementType==='SALES_SELF_ORDER' && Number(item.supplyOrderedQty||0)>0);
            showActionFeedback(automaticallyOrdered
                ? '訂單已建立；自行訂貨已記錄為已採購，等待到貨。'
                : '訂單已建立，庫存預留已同步。', 'success');
        }
    }).catch(err => {
        pendingOrderReservationIds.delete(createdOrderId);
        if(currentUser?.uid!==savingUid)return;
        if (createdOrderId) {
            const cachedOrder=ordersCache.find(order=>order.id===createdOrderId);
            if(cachedOrder)Object.assign(cachedOrder,data);
            writeAppDataCache('orders',ordersCache);
            renderOrdersList();
            showActionFeedback(`訂單已建立，但庫存同步未完成。請在該筆訂單按「重試同步」，不要另建一張：${err.message}`,'warning');
        } else {
            alert('儲存狀態尚未確認；請按儲存重試同一張訂單，勿另開新單：' + err.message);
        }
    }).finally(() => {
        if(!createdOrderId){
            newOrderSaveInProgress = false;
            if (saveButton) { saveButton.disabled = false; saveButton.innerText = '建立訂單'; }
        }
    });
};

// 匯出指定日期區間的訂單（供採購下單使用），不受畫面上目前的搜尋關鍵字影響
window.exportOrdersByDate = async function() {
    const start = document.getElementById('exportStartDate').value;
    const end = document.getElementById('exportEndDate').value;
    if (!start || !end) {
        alert('請選擇起訖日期');
        return;
    }
    try {
        await ensureXlsxLoaded();
    } catch (err) {
        alert(err.message);
        return;
    }

    // 在查詢階段限制自己的訂單，與資料庫權限規則一致。
    if (start > end) return alert('起日不可晚於迄日。');
    let exportQuery = db.collection('orders')
        .where('orderDate', '>=', start)
        .where('orderDate', '<=', end)
        .orderBy('orderDate', 'desc');
    if (!canViewAllData('orders')) {
        if(currentUserCode) exportQuery=exportQuery.where('salesCode','==',currentUserCode);
        else exportQuery=db.collection('orders').where('ownerUid','==',currentUser.uid);
    }
    readQueryInBatches(exportQuery).then(async records => {
            const rows = [];
            records.forEach(o => {
                if((o.orderDate||'')<start||(o.orderDate||'')>end)return;
                if (!canViewAllData('orders') && !belongsToCurrentUser(o.salesName, o.ownerUid)) {
                    return;
                }
                rows.push({
                    '訂單日期': o.orderDate || '',
                    '客戶名稱': o.customerName || '',
                    '廠牌': o.brand || '',
                    '產品線': productLineForOrder(o),
                    '貨號': o.itemCode || '',
                    '品名': o.itemName || '',
                    '數量': o.qty || '',
                    '單價': o.unitPrice || '',
                    '總價': o.totalPrice || '',
                    '交易方式': o.transactionType || '',
                    '抬頭': o.invoiceTitle || '',
                    '核銷日期': orderBillingDate(o),
                    '來源估價單': o.quoteNo || '',
                    '負責業務': stripPhoneSuffix(o.salesName)
                });
            });

            if (!rows.length) {
                alert('這個日期區間內沒有訂單資料。');
                return;
            }

            rows.sort((a, b) => (a['訂單日期'] || '').localeCompare(b['訂單日期'] || ''));

            const ws = XLSX.utils.json_to_sheet(rows);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, '訂單');
            XLSX.writeFile(wb, `訂單_${start}_至_${end}.xlsx`);
        }).catch(err => {
            alert('匯出失敗：' + err.message + '\n請確認目前這筆資料及連線／權限，重試前先查詢作業結果；若持續失敗，請聯絡管理員。');
        });
};

