// Existing physical return writers, shared by receiving and hold-release UI.
// No prompts, DOM, query rendering or second inventory implementation.
async function postCustomerReturnStock(tx,order,item,qty,receiptId,warehouseId){
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
        const order={id:orderId,...orderSnap.data()},requests=[...(order.returnRequests||[])],index=requests.findIndex(r=>r.id===requestId);
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
        const order={id:receipt.orderId,...orderSnap.data()},item=normalizedOrderItems(order).find(i=>i.itemId===receipt.itemId);
        const record=savedReturnRecords(order).find(r=>r.id===id);if(!item||!record)throw new Error('找不到原退貨品項或紀錄。');
        await assertActiveReturnWarehouse(tx,receipt.warehouseId);
        if((item.fulfillmentType||order.fulfillmentType||'WAREHOUSE')!=='DIRECT_SHIP'&&item.warehouseId&&item.warehouseId!==receipt.warehouseId)
            throw new Error('原收貨倉庫與來源訂單不一致，請先查核再轉庫存。');
        await postCustomerReturnStock(tx,{...order,returnRecords:savedReturnRecords(order).filter(r=>r.id!==id)},item,Number(receipt.qty),id,receipt.warehouseId);
        tx.update(receiptRef,{disposition:'STOCK',releasedAt:new Date().toISOString(),releasedBy:currentUser.uid});
    });
}
