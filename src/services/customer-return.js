// Customer cancellation/return writers shared by the existing UI actions.
// No prompts, DOM, query rendering or second inventory implementation.
function customerReturnNeedsLocationReceipt(order) {
    return Array.isArray(order?.warehouseShipmentRecords) && order.warehouseShipmentRecords.length > 0;
}
function assertLegacyCustomerReturnSource(order) {
    if(customerReturnNeedsLocationReceipt(order))
        throw new Error('此出貨來源的退貨收貨尚未開放，請保留待收申請；不能使用一般退貨入庫。');
}
function customerReturnPendingQty(order, itemId, excludeId='') {
    return (order.returnRequests||[]).filter(r=>r.itemId===itemId && r.id!==excludeId && r.status==='PENDING')
        .reduce((sum,r)=>sum+Math.max(0,Number(r.qty)-Number(r.receivedQty||0)),0);
}
function customerReturnActorContext(capability) {
    const actorUid=currentUser?.uid,actorRole=typeof currentUserRole==='undefined'?null:currentUserRole;
    const assertCurrent=()=>{
        if(!actorUid||currentUser?.uid!==actorUid
            ||(typeof currentUserRole==='undefined'?null:currentUserRole)!==actorRole||!capability())
            throw new Error('登入帳號或權限已變更，請重新開啟作業。');
    };
    assertCurrent();return {actorUid,actorRole,assertCurrent};
}
function customerReturnRequestMatches(record,{operationId,itemId,qty,date,reason,actorUid}) {
    return !!record && record.id===operationId && record.itemId===itemId
        && record.qty===qty && record.date===date && record.reason===reason
        && record.settlement==='CLOSE' && record.createdByUid===actorUid;
}
async function readCommittedCustomerReturnRequest(intent,actorRole,assertCurrent) {
    // A concurrent stale proposal can be denied before the SDK retries it.
    // Re-read the profile and immutable request in one fresh, read-only transaction.
    let confirmed=null;
    await runRoleTransaction(async tx=>{
        confirmed=null;assertCurrent();
        const user=await tx.get(db.collection('users').doc(intent.actorUid));assertCurrent();
        if(!user.exists)return;
        const profile=user.data();
        if((profile.active!==undefined&&profile.active!==true)||profile.disabled===true
            ||profile.role!==actorRole||!['admin','sales','engineer'].includes(profile.role))return;
        // Client Rules recheck ownership; transaction retries also re-read this profile.
        const snapshot=await tx.get(db.collection('orders').doc(intent.orderId));assertCurrent();
        if(!snapshot.exists)return;
        const order={...snapshot.data(),id:intent.orderId};
        if(customerReturnRequestMatches((order.returnRequests||[]).find(r=>r.id===intent.operationId),intent))confirmed=order;
    });
    assertCurrent();return confirmed;
}
async function commitCustomerReturnRequest({orderId,itemId,operationId,qty,date,reason=''}) {
    const {actorUid,actorRole,assertCurrent}=customerReturnActorContext(()=>canManageOrderLifecycleCapability());
    if([orderId,itemId,operationId].some(id=>typeof id!=='string'||!id||id!==id.trim()||id.includes('/')||id.length>160)
        ||!Number.isFinite(qty)||qty<=0||typeof reason!=='string'
        ||typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)
        ||!Number.isFinite(Date.parse(date+'T00:00:00Z'))
        ||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date)
        throw new Error('退貨品項、日期或數量不正確。');
    reason=reason.trim();const actor=deliveryActor();let saved;
    const intent={orderId,itemId,operationId,qty,date,reason,actorUid};
    try{await runRoleTransaction(async tx=>{
        assertCurrent();const ref=db.collection('orders').doc(orderId),snap=await tx.get(ref);assertCurrent();
        if(!snap.exists)throw new Error('找不到訂單。');const order={...snap.data(),id:orderId};
        const requests=[...(order.returnRequests||[])],prior=requests.find(r=>r.id===operationId);
        if(prior){
            if(!customerReturnRequestMatches(prior,intent))
                throw new Error('退貨申請識別碼已對應其他內容，請先查詢原申請結果。');
            saved=order;return;
        }
        const item=normalizedOrderItems(order).find(i=>i.itemId===itemId);if(!item)throw new Error('找不到原送貨品項。');
        const allowed=returnItemDeliveredQty(order,itemId)-returnItemReturnedQty(order,itemId)-customerReturnPendingQty(order,itemId);
        if(requests.length>=30)throw new Error('每張訂單最多 30 次退貨申請，請先處理既有申請。');
        if(qty>allowed+1e-9)throw new Error(`最多可申請 ${Math.max(0,allowed)} 個；已扣除其他待收退貨。`);
        const now=new Date().toISOString(),record={id:operationId,itemId,qty,receivedQty:0,date,reason,status:'PENDING',settlement:'CLOSE',createdAt:now,createdBy:actor,createdByUid:actorUid};
        requests.push(record);const patch={returnRequests:requests,returnPending:true,returnRequestMutationIndex:requests.length-1,updatedAt:now};
        assertCurrent();tx.update(ref,patch);saved={...order,...patch};
    });}catch(error){
        if(error.code!=='permission-denied')throw error;
        assertCurrent();
        try{saved=await readCommittedCustomerReturnRequest(intent,actorRole,assertCurrent);}
        catch(_){assertCurrent();throw error;}
        if(!saved)throw error;
    }
    assertCurrent();return saved;
}
async function commitCustomerReturnWithdrawal({orderId,requestId}) {
    const {actorUid,assertCurrent}=customerReturnActorContext(()=>canManageOrderLifecycleCapability());let saved;
    await runRoleTransaction(async tx=>{
        assertCurrent();const ref=db.collection('orders').doc(orderId),snap=await tx.get(ref);assertCurrent();
        if(!snap.exists)throw new Error('找不到訂單。');const order={...snap.data(),id:orderId},requests=[...(order.returnRequests||[])];
        const index=requests.findIndex(r=>r.id===requestId);if(index<0)throw new Error('找不到退貨申請。');
        if(requests[index].status!=='PENDING'){saved=order;return;}
        const now=new Date().toISOString();requests[index]={...requests[index],status:'CANCELLED',cancelledAt:now,cancelledBy:actorUid};
        const patch={returnRequests:requests,returnPending:requests.some(r=>r.status==='PENDING'),returnRequestMutationIndex:index,updatedAt:now};
        assertCurrent();tx.update(ref,patch);saved={...order,...patch};
    });
    assertCurrent();return saved;
}
async function commitCancelledPurchaseKeepStock({supplyId,warehouseId,expectedDirect}) {
    const {actorUid,assertCurrent}=customerReturnActorContext(()=>canCreatePurchaseOrderCapability());let saved;
    const actor=deliveryActor();
    if(typeof expectedDirect!=='boolean')throw new Error('缺少原採購收貨方式。');
    await runRoleTransaction(async tx=>{
        assertCurrent();const ref=supplyOrdersCollection().doc(supplyId),snap=await tx.get(ref);assertCurrent();
        if(!snap.exists)throw new Error('找不到採購品項。');const supply={...snap.data(),id:supplyId};
        const orderSnap=await tx.get(db.collection('orders').doc(supply.orderId));assertCurrent();
        if(!orderSnap.exists||normalizedOrderStatus(orderSnap.data())==='normal')throw new Error('客戶訂單未取消，請重新確認。');
        if(isPurchaseTerminalStatus(supply.status))throw new Error('採購已取消／結案。');
        if(supply.customerCancellationDisposition==='KEEP_STOCK'){saved=supply;return;}
        const remaining=Math.max(0,Number(supply.qty||0)-Number(supply.receivedQty||0));
        if(!remaining)throw new Error('此品項已全部到貨。');
        const key=String(supply.productKey||supply.productId||''),redirect=supply.fulfillmentType==='DIRECT_SHIP';
        if(redirect!==expectedDirect)throw new Error('採購收貨方式已變更，請更新清單後重新確認。');
        if(redirect)await assertActiveReturnWarehouse(tx,warehouseId);
        const invRef=redirect?db.collection('inventory').doc(encodeURIComponent(key)):null;
        const whRef=redirect?db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,key)):null;
        const invSnap=invRef?await tx.get(invRef):null,whSnap=whRef?await tx.get(whRef):null;
        if(redirect&&!key)throw new Error('缺少產品識別碼。');
        const now=new Date().toISOString(),patch={customerCancellationDisposition:'KEEP_STOCK',customerCancellationResolvedAt:now,customerCancellationResolvedBy:actorUid,updatedAt:now};
        assertCurrent();
        if(redirect){
            Object.assign(patch,{originalFulfillmentType:'DIRECT_SHIP',fulfillmentType:'WAREHOUSE',warehouseId,redirectInventoryId:encodeURIComponent(key),redirectWarehouseStockId:warehouseStockDocId(warehouseId,key),incomingRegisteredQty:remaining});
            const info={productKey:key,productId:supply.productId||key,itemCode:supply.itemCode||'',itemName:supply.itemName||'',brand:supply.brand||'',updatedAt:now};
            tx.set(invRef,{...info,incoming:Number(invSnap?.data()?.incoming||0)+remaining},{merge:true});
            tx.set(whRef,{...info,warehouseId,incoming:Number(whSnap?.data()?.incoming||0)+remaining},{merge:true});
            tx.set(db.collection('inventoryMovements').doc('redirect-'+supplyId),{type:'cancelled_direct_ship_redirect',qty:remaining,productKey:key,warehouseId,sourceType:'SUPPLY_ORDER',sourceId:supplyId,createdAt:now,createdBy:actor});
        }
        tx.update(ref,patch);saved={...supply,...patch};
        // runRoleTransaction mirrors supply changes to the receiving view atomically.
    });
    assertCurrent();return saved;
}
async function postCustomerReturnStock(tx,order,item,qty,receiptId,warehouseId){
    assertLegacyCustomerReturnSource(order);
    const itemDeliveries=savedDeliveryRecords(order).filter(r=>r.itemId===item.itemId||(!r.itemId&&order.items.length===1));
    const itemReturns=savedReturnRecords(order).filter(r=>r.itemId===item.itemId||(!r.itemId&&order.items.length===1));
    if((item.fulfillmentType||order.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP'){
        // Settlement returns are free stock; never reserve them for the original customer.
        return applyInventoryReturnDeltaInTransaction(tx,{...order,...item,customerReturnSettlement:'CLOSE',warehouseId,itemId:item.itemId,deliveryRecords:itemDeliveries,returnRecords:itemReturns},qty,deliveryActor(),order.id,null);
    }
    const supplyId=(item.receiptEvents||[]).find(e=>e.fulfillmentType==='DIRECT_SHIP'&&e.sourceId)?.sourceId;
    if(!supplyId)throw new Error('直送退貨缺少原採購來源，請先以「待檢」收貨，補齊原採購來源後再转庫存。');
    const supplySnap=await tx.get(db.collection('receivingSupplyOrders').doc(supplyId));
    if(!supplySnap.exists)throw new Error('找不到原直送採購資料，請先以待檢收貨。');
    const key=inventoryProductKey(item),invRef=db.collection('inventory').doc(encodeURIComponent(key)),whRef=db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,key));
    const invSnap=await tx.get(invRef),whSnap=await tx.get(whRef),lotRef=db.collection('inventoryLots').doc('return-'+receiptId);
    const now=new Date().toISOString(),info={productKey:key,productId:item.productId||key,itemCode:item.itemCode||'',itemName:item.itemName||'',brand:item.brand||'',updatedAt:now};
    tx.set(invRef,{...info,onHand:Number(invSnap.data()?.onHand||0)+qty},{merge:true});
    tx.set(whRef,{...info,warehouseId,onHand:Number(whSnap.data()?.onHand||0)+qty},{merge:true});
    tx.set(lotRef,{...info,warehouseId,qty,remainingQty:qty,sourceType:'SUPPLY_ORDER',sourceId:supplyId,returnReceiptId:receiptId,receivedAt:now,createdAt:now,lotNo:'退貨-'+receiptId});
    tx.set(db.collection('inventoryLotCosts').doc(lotRef.id),{lotId:lotRef.id,productKey:key,warehouseId,costSourceSupplyId:supplyId,sourceType:'SUPPLY_ORDER',sourceId:supplyId,createdAt:now});
    tx.set(db.collection('inventoryMovements').doc('return-'+receiptId),{type:'customer_return_received',qty,productKey:key,warehouseId,sourceType:'ORDER',sourceId:order.id,returnReceiptId:receiptId,createdAt:now,createdBy:deliveryActor()});
    return {lotAllocations:[{lotId:lotRef.id,qty}],newReservedQty:Number(item.reservedQty||0)};
}

async function assertActiveReturnWarehouse(tx,warehouseId){
    if(typeof warehouseId!=='string'||!warehouseId||warehouseId.startsWith('custody-'))throw new Error('退貨收貨只能使用有效的實體倉庫。');
    const warehouseSnap=await tx.get(db.collection('warehouses').doc(warehouseId));
    const warehouse=warehouseSnap.exists?warehouseSnap.data():null;
    if(!warehouse||warehouse.active===false||warehouse.systemCustody===true||warehouse.warehouseType==='CUSTODY')
        throw new Error('收貨倉庫不存在、已停用或屬於業務保管位置，請重新選擇。');
}
async function commitCustomerReturnReceipt({orderId,requestId,receiptId,qty,quality,warehouseId}){
    if(typeof pendingV2CustomerReturnReceipt==='function'&&pendingV2CustomerReturnReceipt(orderId))
        throw new Error('前次後端退貨尚未確認，請以原操作核對，禁止改用一般退貨入庫。');
    if(!canReceiveInventoryCapability())throw new Error('無收貨權限。');
    const actorUid=currentUser?.uid;
    await runRoleTransaction(async tx=>{
        if(!actorUid||currentUser?.uid!==actorUid||!canReceiveInventoryCapability())throw new Error('登入帳號或權限已變更，請重新開啟退貨收貨。');
        const receiptRef=db.collection('customerReturnReceipts').doc(receiptId),orderRef=db.collection('orders').doc(orderId);
        const receiptSnap=await tx.get(receiptRef),orderSnap=await tx.get(orderRef);
        if(currentUser?.uid!==actorUid||!canReceiveInventoryCapability())throw new Error('登入帳號或權限已變更，請重新開啟退貨收貨。');
        if(receiptSnap.exists){
            const receipt=receiptSnap.data();
            if(receipt.orderId!==orderId||receipt.requestId!==requestId||receipt.qty!==qty||receipt.quality!==quality||receipt.warehouseId!==warehouseId||receipt.receivedBy!==actorUid)throw new Error('退貨重試識別碼已對應其他收貨內容，請先查詢原收貨結果。');
            return;
        }
        if(!orderSnap.exists)throw new Error('來源訂單已不存在。');
        const order={id:orderId,...orderSnap.data()};
        assertLegacyCustomerReturnSource(order);
        const requests=[...(order.returnRequests||[])],index=requests.findIndex(r=>r.id===requestId);
        if(index<0||requests[index].status!=='PENDING')throw new Error('退貨申請已撤回或完成。');
        const request=requests[index],remaining=Number(request.qty)-Number(request.receivedQty||0);
        if(!Number.isFinite(qty)||qty<=0||qty>remaining+1e-9)throw new Error(`實收數量不可超過 ${remaining}。`);
        const item=normalizedOrderItems(order).find(i=>i.itemId===request.itemId);if(!item)throw new Error('找不到退貨品項。');
        await assertActiveReturnWarehouse(tx,warehouseId);
        if((item.fulfillmentType||order.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP'&&item.warehouseId&&item.warehouseId!==warehouseId)
            throw new Error('一般退貨必須收到原出貨倉庫，再使用正式調撥流程。');
        if(returnItemReturnedQty(order,item.itemId)+qty>returnItemDeliveredQty(order,item.itemId)+1e-9)throw new Error('累計實收退貨超過已送貨數量。');
        if(!['SALEABLE','INSPECTION','DAMAGED'].includes(quality)||!warehouseId)throw new Error('收貨狀況或倉庫無效。');
        let result={lotAllocations:[]};
        if(quality==='SALEABLE')result=await postCustomerReturnStock(tx,order,item,qty,receiptId,warehouseId);
        else if(item.fulfillmentType!=='DIRECT_SHIP'){
            const deliveries=savedDeliveryRecords(order).filter(r=>r.itemId===item.itemId||(!r.itemId&&order.items.length===1));
            const returns=savedReturnRecords(order).filter(r=>r.itemId===item.itemId||(!r.itemId&&order.items.length===1));
            const available=YushinInventory.availableReturnAllocations(deliveries,returns);
            result.lotAllocations=YushinInventory.reverseLotAllocations([{qty:available.reduce((s,r)=>s+Number(r.qty||0),0),lotAllocations:available}],qty).allocations;
        }
        if(currentUser?.uid!==actorUid||!canReceiveInventoryCapability())throw new Error('登入帳號或權限已變更，請重新開啟退貨收貨。');
        const now=new Date().toISOString(),record={id:receiptId,requestId,itemId:item.itemId,date:localDateString(),qty,reason:request.reason||'',settlement:'CLOSE',quality,warehouseId,createdAt:now,createdBy:deliveryActor(),lotAllocations:result.lotAllocations||[]};
        requests[index]={...request,receivedQty:Number(request.receivedQty||0)+qty,status:qty>=remaining?'RECEIVED':'PENDING'};
        const records=[...savedReturnRecords(order),record],patch={returnRequests:requests,returnPending:requests.some(r=>r.status==='PENDING'),returnRecords:records,returnedQty:records.reduce((s,r)=>s+Number(r.qty||0),0),returnReceiptId:receiptId,updatedAt:now};
        if(result.newReservedQty!==undefined)patch.items=order.items.map(i=>i.itemId===item.itemId?{...i,reservedQty:result.newReservedQty}:i);
        Object.assign(patch,orderWorkIndexFields({...order,...patch}));
        tx.set(receiptRef,{orderId,requestId,requestIndex:index,qty,quality,warehouseId,itemId:item.itemId,itemName:item.itemName||'',ownerUid:order.ownerUid||'',salesCode:order.salesCode||'',disposition:quality==='SALEABLE'?'STOCK':'HOLD',record,createdAt:now,receivedBy:actorUid});
        tx.update(orderRef,patch);
    });
}

async function commitCustomerReturnHoldRelease(id){
    if(!canReceiveInventoryCapability())throw new Error('無收貨權限。');
    await runRoleTransaction(async tx=>{
        const receiptRef=db.collection('customerReturnReceipts').doc(id),snap=await tx.get(receiptRef);
        if(!snap.exists)throw new Error('找不到退貨收貨紀錄。');const receipt=snap.data();if(receipt.disposition!=='HOLD')return;
        const orderRef=db.collection('orders').doc(receipt.orderId),orderSnap=await tx.get(orderRef);if(!orderSnap.exists)throw new Error('原訂單已不存在。');
        const order={id:receipt.orderId,...orderSnap.data()};
        assertLegacyCustomerReturnSource(order);
        const item=normalizedOrderItems(order).find(i=>i.itemId===receipt.itemId);
        const record=savedReturnRecords(order).find(r=>r.id===id);if(!item||!record)throw new Error('找不到原退貨品項或紀錄。');
        await assertActiveReturnWarehouse(tx,receipt.warehouseId);
        if((item.fulfillmentType||order.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP'&&item.warehouseId&&item.warehouseId!==receipt.warehouseId)
            throw new Error('原收貨倉庫與來源訂單不一致，請先查核再轉庫存。');
        await postCustomerReturnStock(tx,{...order,returnRecords:savedReturnRecords(order).filter(r=>r.id!==id)},item,Number(receipt.qty),id,receipt.warehouseId);
        tx.update(receiptRef,{disposition:'STOCK',releasedAt:new Date().toISOString(),releasedBy:currentUser.uid});
    });
}
