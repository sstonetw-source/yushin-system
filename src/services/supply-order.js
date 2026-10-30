// Purchasing transactions and checkpoints; no editor, DOM or UI-cache ownership.
function poIncomingKey(item) {
    return String(item.productId || (item.itemCode ? `code:${normalizeHistoryItemCode(item.itemCode)}` : '')).trim();
}
async function registerPurchaseIncoming(poId, poRecord, {actorUid=currentUser?.uid,actorRole=currentUserRole,onStockCommitted=null}={}) {
    // Explicit Emulator-only backend pilot. An unknown Callable result keeps
    // the original formal-po-pending checkpoint and cannot fall back to SDK.
    if(globalThis.YUSHIN_V2_PO_INCOMING_EMULATOR===true)
        return registerFormalPurchaseIncomingBackend(poId,poRecord,{actorUid,actorRole,onStockCommitted});
    if (poRecord?.status==='DRAFT' || poRecord?.documentOnly===true) throw Error('採購文件尚未確認已採購，不能登記在途。');
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
            if(livePo.status==='DRAFT'||livePo.documentOnly===true)throw Error('原採購文件尚未確認已採購。');
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
        try{
            assertActor();
            if (committedStock) onStockCommitted?.(committedStock.key,committedStock.warehouseId);
        }catch(err){
            if(committedStock)err.incomingCommitted=true;
            throw err;
        }
    }
}

async function registerFormalPurchaseIncomingBackend(poId,poRecord,{actorUid,actorRole,onStockCommitted}){
    const local=host=>['localhost','127.0.0.1'].includes(host);
    const hostname=String(globalThis.location?.hostname||'').toLowerCase();
    if(globalThis.YUSHIN_V2_PO_INCOMING_EMULATOR!==true||!local(hostname)
        ||typeof APP_ENVIRONMENT==='undefined'||APP_ENVIRONMENT!=='emulator'
        ||typeof firebase==='undefined'||!firebase.auth||!firebase.app
        ||!formalPurchaseBackendPilotEnabled())
        throw Error('正式 PO 在途後端僅開放隔離 Emulator，禁止回退舊寫入。');
    const auth=firebase.auth(),app=firebase.app();
    if(app.options?.projectId!=='demo-yushin'||auth.app?.options?.projectId!=='demo-yushin'
        ||db?.app?.options?.projectId!=='demo-yushin'
        ||!local(auth.emulatorConfig?.host)||auth.emulatorConfig?.port!==9099)
        throw Error('正式 PO 在途 Auth／Firestore 專案或 Emulator 不一致。');
    const check=()=>{
        if(!actorUid||currentUser?.uid!==actorUid||auth.currentUser?.uid!==actorUid
            ||currentUserRole!==actorRole||!['admin','purchaser'].includes(actorRole)
            ||!canCreatePurchaseOrderCapability()||!canAccessPage('orders.po'))
            throw Error('採購在途的登入身分或權限已變更。');
    };
    check();
    if(!poRecord||poRecord.status!=='ORDERED'||poRecord.documentOnly===true
        ||poRecord.poNo!==poId||!Array.isArray(poRecord.items)
        ||poRecord.items.length<1||poRecord.items.length>5
        ||!Array.isArray(poRecord.supplyOrderIds)||poRecord.supplyOrderIds.length!==poRecord.items.length)
        throw Error('正式 PO 尚未具有完整後端採購與供應來源。');
    await ensureFormalPurchaseFunctionsCompat();check();
    const functions=app.functions('asia-east1');
    if(functions.app?.options?.projectId!=='demo-yushin')throw Error('正式 PO 在途 Functions 專案不正確。');
    functions.useEmulator('127.0.0.1',5001);
    const result=(await functions.httpsCallable('registerV2FormalPurchaseIncoming')({poNo:poId}))?.data;
    check();
    if(!['applied','already-applied'].includes(result?.status)||result.poNo!==poId
        ||result.receiptId!=='po-incoming-'+encodeURIComponent(poId)
        ||JSON.stringify(result.supplyOrderIds)!==JSON.stringify(poRecord.supplyOrderIds))
        throw Error('在途入帳結果不明，請保留原採購單號核對。');
    for(const supplyId of result.supplyOrderIds){
        const snap=await db.collection('supplyOrders').doc(supplyId).get({source:'server'});check();
        const supply=snap.exists?snap.data():null;
        if(!supply||supply.purchaseDocumentId!==poId
            ||supply.incomingRegisteredQty!==((supply.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP'?0:supply.qty-supply.receivedQty))
            throw Error('原在途交易已回覆，但來源供應紀錄尚未可核對；請使用原單號重試。');
        if((supply.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP')
            onStockCommitted?.(supply.productKey,supply.warehouseId);
    }
}

async function cancelOutstandingSupplyRecord(poId, supplyId, reason, {actorUid=currentUser?.uid,actorRole=currentUserRole,onStockCommitted=null,onDemandChanged=null}={}) {
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
    try{
        assertActor();
        if(result.productKey&&result.warehouseId)onStockCommitted?.(result.productKey,result.warehouseId);
        if(result.demandId)onDemandChanged?.(result.demandId);
    }catch(err){
        err.supplyCommitted=true;
        err.supplyResult=result;
        throw err;
    }
    return result;
}

async function stopPurchaseOrderOutstanding(poId,reason,{actorUid=currentUser?.uid,actorRole=currentUserRole,onStockCommitted=null,onDemandChanged=null}={}) {
    const assertActor=()=>{
        if(!actorUid||currentUser?.uid!==actorUid||currentUserRole!==actorRole)throw new Error('登入身份已變更，請以原帳號重試取消。');
        if(!canCreatePurchaseOrderCapability())throw new Error('目前無採購取消權限。');
    };
    if(typeof reason!=='string'||!reason.trim())throw new Error('請填寫取消原因。');
    reason=reason.trim();assertActor();
    const actor={actorUid,actorRole,onStockCommitted,onDemandChanged},actorName=currentUserName||currentUser?.email||'',now=new Date().toISOString();
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

