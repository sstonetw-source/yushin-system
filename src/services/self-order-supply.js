// Shared supplier commitment workflow for initial and manual self-orders.
function selfOrderBackendEnabled(){
    return typeof APP_ENVIRONMENT!=='undefined'&&(
        (APP_ENVIRONMENT==='emulator'&&globalThis.YUSHIN_SELF_ORDER_EMULATOR===true)
        ||(APP_ENVIRONMENT==='preview'&&globalThis.YUSHIN_PREVIEW_SELF_ORDER===true)
        ||(APP_ENVIRONMENT==='production'&&globalThis.YUSHIN_PRODUCTION_SELF_ORDER===true));
}
function selfOrderPendingKey(uid,orderId,itemId){
    return 'self-order-pending:'+encodeURIComponent(uid)+':'+encodeURIComponent(orderId)+':'+encodeURIComponent(itemId);
}
async function commitSelfOrderBackend(orderId,itemId,details){
    const uid=details.actorUid,env=APP_ENVIRONMENT;
    const project=env==='emulator'?'demo-yushin':env==='preview'?'preview-20135':'yu-shing-company';
    const host=String(globalThis.location?.hostname||'').toLowerCase();
    const pathname=String(globalThis.location?.pathname||'');
    const prod=env==='production'&&globalThis.location?.origin==='https://sstonetw-source.github.io'
        &&host==='sstonetw-source.github.io'&&(pathname==='/yushin-system'||pathname.startsWith('/yushin-system/'));
    const preview=env==='preview'&&['preview-20135.web.app','preview-20135.firebaseapp.com'].includes(host);
    const emulator=env==='emulator'&&typeof firebase!=='undefined'&&['localhost','127.0.0.1'].includes(host)
        &&['localhost','127.0.0.1'].includes(firebase.auth().emulatorConfig?.host)
        &&firebase.auth().emulatorConfig?.port===9099;
    if(!selfOrderBackendEnabled()||typeof firebase==='undefined'||!firebase.auth||!firebase.app
        ||!(prod||preview||emulator)||firebase.auth().app?.options?.projectId!==project
        ||firebase.app().options?.projectId!==project||db.app?.options?.projectId!==project
        ||(env!=='emulator'&&firebase.auth().emulatorConfig))
        throw Error('業務自行訂貨後端尚未在此授權環境啟用，已禁止舊版瀏覽器寫入。');
    const key=selfOrderPendingKey(uid,orderId,itemId);
    const fingerprint=JSON.stringify([uid,orderId,itemId,details.qty,details.supplier,details.unitCost,details.orderDate,details.notes]);
    let pending;
    try{const raw=sessionStorage.getItem(key);if(raw)pending=JSON.parse(raw);}
    catch(_){throw Error('前次自行訂貨的操作憑證無法讀取，請先核對原訂貨紀錄。');}
    if(pending&&(pending.version!==1||pending.fingerprint!==fingerprint
        ||typeof pending.operationId!=='string'||!/^so-[A-Za-z0-9_-]{8,76}$/.test(pending.operationId)))
        throw Error('前次自行訂貨尚待核對，請保留原內容與操作識別碼重試。');
    const operationId=pending?.operationId||('so-'+db.collection('purchaseOperations').doc().id);
    if(!pending){
        try{sessionStorage.setItem(key,JSON.stringify({version:1,fingerprint,operationId}));}
        catch(_){throw Error('無法保留自行訂貨重試憑證，未提交訂貨。');}
    }
    await ensureFormalPurchaseFunctionsCompat();
    const fn=firebase.app().functions('asia-east1');
    if(fn.app?.options?.projectId!==project)throw Error('自行訂貨後端連線專案不正確。');
    if(emulator)fn.useEmulator('127.0.0.1',5001);
    const check=()=>{
        if(currentUser?.uid!==uid||currentUserRole!==details.actorRole||firebase.auth().currentUser?.uid!==uid)
            throw Error('登入身分已變更，請以原帳號查核自行訂貨結果。');
    };
    check();
    const response=await fn.httpsCallable('commitV2SelfOrder')({operationId,orderId,itemId,
        qty:details.qty,supplier:details.supplier,unitCost:details.unitCost,
        orderDate:details.orderDate,notes:details.notes});
    check();
    const result=response?.data;
    const supplyId='self-'+encodeURIComponent(orderId)+'-'+encodeURIComponent(itemId);
    const demandId=globalThis.YushinProcurementDemand.demandIdForSource({sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId});
    if(!['committed','already-applied'].includes(result?.status)||result.operationId!==operationId
        ||result.supplyId!==supplyId||result.demandId!==demandId||result.committedQty!==details.qty)
        throw Error('自行訂貨回覆不完整，請使用原操作查核。');
    const read=async(collection,id)=>{
        const snap=await db.collection(collection).doc(id).get({source:'server'});check();
        if(!snap.exists)throw Error('自行訂貨可能已提交，但權威憑證回讀不完整。');
        return snap.data();
    };
    const [order,supply,demand]=await Promise.all([
        read('orders',orderId),read('receivingSupplyOrders',supplyId),
        read('procurementDemands',encodeURIComponent(demandId))]);
    const line=order.items?.find(item=>item.itemId===itemId);
    if(!line?.orderEvents?.some(event=>event.id==='self-'+operationId&&event.qty===details.qty)
        ||supply.demandId!==demandId||demand.demandId!==demandId
        ||supply.qty<details.qty||!line.selfOrderNos?.includes(supply.internalNo))
        throw Error('自行訂貨來源、供應或需求憑證不一致，請保留原操作查核。');
    check();
    try{sessionStorage.removeItem(key);}catch(_){throw Error('自行訂貨已確認，但無法清除待查憑證。');}
    return {order,internalNo:supply.internalNo};
}
async function registerInitialSelfOrderSupply(orderId,itemId,details) {
    return (await commitSelfOrderSupply(orderId,itemId,{...details,initial:true})).order;
}

async function commitSelfOrderSupply(orderId,itemId,{supplier,qty,unitCost,orderDate,notes='',actorUid=currentUser?.uid,actorRole=currentUserRole,initial=false,operationId=''}) {
        // Creation-time confirmed self-orders require one atomic order/reservation
        // commit and remain disabled in production. Manual commitments can use
        // the independently gated authoritative supplier/incoming writer.
        const prod=typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='production';
        const preview=typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='preview';
        let pending=false;
        if(!initial){
            try{pending=typeof sessionStorage!=='undefined'
                &&sessionStorage.getItem(selfOrderPendingKey(actorUid,orderId,itemId))!==null;}
            catch(_){throw Error('前次自行訂貨操作憑證無法讀取，請先核對。');}
        }
        if(initial&&(prod||preview||selfOrderBackendEnabled()))throw Error('新建訂單已確認自行訂貨需原子建單後端，已阻止瀏覽器直接建立供應。');
        if(!initial&&(prod||preview||pending||selfOrderBackendEnabled())){
            if(!selfOrderBackendEnabled())throw Error('業務自行訂貨後端尚未啟用，已阻止瀏覽器直接寫入。');
            return commitSelfOrderBackend(orderId,itemId,{supplier,qty,unitCost,orderDate,notes:notes.trim(),actorUid,actorRole});
        }
        if(typeof supplier!=='string'||!supplier.trim()||!Number.isFinite(qty)||qty<=0||!Number.isFinite(unitCost)||unitCost<0||typeof notes!=='string')
            throw new Error('請填寫供應商、有效訂貨數量與實際單位成本（可填 0）。');
        if(typeof orderDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(orderDate)||!Number.isFinite(Date.parse(orderDate+'T00:00:00Z'))||new Date(orderDate+'T00:00:00Z').toISOString().slice(0,10)!==orderDate)
            throw new Error('請填寫正確的訂貨日期。');
        if(!initial&&(typeof operationId!=='string'||!operationId.trim()||operationId.includes('/')))
            throw new Error('缺少有效自行訂貨作業識別碼，請重新開啟表單。');
        supplier=supplier.trim();notes=notes.trim();
        const role=actorRole,actor=deliveryActor(),now=new Date().toISOString();
        const assertActor=()=>{if(currentUser?.uid!==actorUid||currentUserRole!==role)throw new Error('登入身份已變更，請以原帳號重試同步。');};
        assertActor();
        const supplyRef=supplyOrdersCollection().doc(initial?`self-${encodeURIComponent(orderId)}-${encodeURIComponent(itemId)}`:operationId);
        let savedOrder,internalNo='';
        await runRoleTransaction(async tx=>{
            const orderRef=db.collection('orders').doc(orderId);
            const snap=await tx.get(orderRef);
            assertActor();
            if(!snap.exists)throw new Error('找不到訂單。');
            const order=snap.data();

            if(!initial&&orderInventorySyncIncomplete(order))throw new Error('訂單庫存尚未同步完成');
            if(!canBusinessSelfOrder(order)&&!(initial&&canCreatePurchaseOrderCapability()))throw new Error('只有此訂單負責業務可自行訂貨。');
            if(normalizedOrderStatus(order)!=='normal')throw new Error('已取消訂單不能自行訂貨。');
            const items=normalizedOrderItems(order);
            const index=items.findIndex(row=>row.itemId===itemId);
            if(index<0)throw new Error('找不到訂單品項。');
            const item=items[index];
            if ((item.procurementType || order.procurementType || 'PURCHASING_PO') !== 'SALES_SELF_ORDER') throw new Error('此品項設定為交由採購，不能自行訂貨。');
            const existingSupply=await tx.get(supplyRef);
            assertActor();
            if(existingSupply.exists){
                const prior=existingSupply.data();
                if(prior.type!=='SALES_SELF_ORDER'||prior.sourceId!==orderId||prior.sourceItemId!==itemId
                    ||Number(prior.qty)!==qty||Number(prior.unitCost)!==unitCost||prior.supplier!==supplier
                    ||prior.orderDate!==orderDate||String(prior.notes||'')!==notes)
                    throw new Error('自行訂貨作業識別碼衝突，請先核對原訂貨紀錄。');
                savedOrder=order;internalNo=prior.internalNo;return;
            }
            const already=Math.max(0,Number(item.supplyOrderedQty||0));
            const demand=procurementDemandForOrderItem({...order,id:orderId},item);
            const remaining=demand.remainingToOrderQty;
            if(qty>remaining+1e-9)throw new Error(`目前尚未訂貨數量只有 ${remaining}。`);
            internalNo=`SO-${orderDate.replace(/-/g,'')}-${initial?`${orderId.slice(-6)}-${itemId.slice(-6)}`.toUpperCase():supplyRef.id.slice(-6).toUpperCase()}`;
            const demandOrderPlan=globalThis.YushinProcurementDemand.applyOrder(demand,qty);
            if(demandOrderPlan.appliedQty!==qty)throw new Error('採購需求數量已變更，請重新整理後再試。');
            const demandRef=procurementDemandRef(demand.demandId);
            const demandDoc=procurementDemandDocument(demandOrderPlan.demand,{
                productId:item.productId||'',
                productKey:inventoryProductKey(item),
                itemCode:item.itemCode||'',
                itemName:item.itemName||'',
                brand:item.brand||'',
                fulfillmentType:item.fulfillmentType||'WAREHOUSE',
                warehouseId:(item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP'?'':(item.warehouseId||defaultWarehouse()?.id||''),
                ownerUid:order.ownerUid||currentUser?.uid||'',
                salesCode:order.salesCode||currentUserCode||'',
                salesName:order.salesName||currentUserName||'',
                scheduleDate:item.scheduleDate||order.expectedDate||''
            },{
                createdAt:order.createdAt||now,
                updatedAt:now
            });
            const record={
                type:'SALES_SELF_ORDER',method:'SALES_SELF_ORDER',
                sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId,demandId:demand.demandId||'',
                internalNo,status:'ORDERED',orderId,itemId,
                ownerUid:order.ownerUid||currentUser?.uid||'',salesCode:order.salesCode||currentUserCode||'',
                salesName:order.salesName||currentUserName||'',
                customerName:order.customerName||'',productId:item.productId||'',productKey:inventoryProductKey(item),
                itemCode:item.itemCode||'',itemName:item.itemName||'',brand:item.brand||'',
                qty,receivedQty:0,supplier,unitCost,orderDate,notes,
                fulfillmentType:item.fulfillmentType||'WAREHOUSE',
                warehouseId:(item.fulfillmentType||'WAREHOUSE')==='DIRECT_SHIP' ? '' : (item.warehouseId||defaultWarehouse()?.id||''),
                createdAt:now,createdByUid:actorUid,createdBy:actor,createdByRole:role
            };
            if(!globalThis.YushinSupply?.validate)throw new Error('供應核心未載入，無法登記自行訂貨。');
            const validation=globalThis.YushinSupply.validate(record);
            if(!validation.valid)throw new Error('自行訂貨資料不完整：'+validation.errors.join(', '));
            assertActor();
            tx.set(supplyRef,record);
            if(demandRef)tx.set(demandRef,demandDoc,{merge:true});
            items[index]={
                ...item,
                supplyOrderedQty:already+qty,
                supplier,costPrice:unitCost,
                selfOrderNos:[...new Set([...(item.selfOrderNos||[]),internalNo])],
                orderedAt:item.orderedAt && item.orderedAt < orderDate ? item.orderedAt : orderDate,
                orderEvents:[
                    ...(item.orderEvents||[]).filter(event=>event.id!==supplyRef.id),
                    {id:supplyRef.id,type:'SALES_SELF_ORDER',at:now,date:orderDate,qty,documentNo:internalNo,by:actor}
                ]
            };
            savedOrder={...order,items,itemCount:items.length,orderSchemaVersion:2,updatedAt:now};
            tx.update(orderRef,{items,itemCount:items.length,orderSchemaVersion:2,...orderWorkIndexFields(savedOrder),updatedAt:now});
        });
    return {order:savedOrder,internalNo};
}

async function registerInitialSelfOrders(orderId,order,actorUid=currentUser?.uid,actorRole=currentUserRole) {
    if(order.selfOrderAtCreation!==true)return;
    let changed=false;
    try{
        for(const item of normalizedOrderItems(order)){
            if((item.procurementType||order.procurementType)!=='SALES_SELF_ORDER'||item.selfOrderConfirmed!==true)continue;
            const qty=remainingProcurementQty(order,item);
            if(qty<=0)continue;
            const saved=await registerInitialSelfOrderSupply(orderId,item.itemId,{supplier:item.supplier,qty,unitCost:Number(item.costPrice),orderDate:order.orderDate,actorUid,actorRole});
            Object.assign(order,saved);
            changed=true;
        }
    }finally{
        // Refresh the pending demand once per order, even if a later line fails.
        if(changed)invalidateProcurementDemandQueue();
    }
}
