// Shared supplier commitment workflow for initial and manual self-orders.
async function registerInitialSelfOrderSupply(orderId,itemId,details) {
    return (await commitSelfOrderSupply(orderId,itemId,{...details,initial:true})).order;
}

async function commitSelfOrderSupply(orderId,itemId,{supplier,qty,unitCost,orderDate,notes='',actorUid=currentUser?.uid,actorRole=currentUserRole,initial=false,operationId=''}) {
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
