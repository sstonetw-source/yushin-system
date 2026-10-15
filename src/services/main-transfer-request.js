// Main-warehouse replenishment requests hold free stock; dispatch/receipt are separate.
async function createMainTransferRequest({id,inventoryId,fromWarehouseId,qty}) {
    if(!canManageInventoryStockPolicy()||!canEditPage('inventory'))throw Error('只有採購或管理員可發起主倉備貨調撥。');
    if(typeof id!=='string'||!id.trim()||id.length>128||!Number.isFinite(qty)||qty<=0||qty>1000000)throw Error('調回數量或識別碼不正確。');
    const toWarehouseId=defaultWarehouse()?.id||'',actorUid=currentUser.uid,actorRole=currentUserRole,now=new Date().toISOString();
    if(!toWarehouseId||!fromWarehouseId||fromWarehouseId===toWarehouseId)throw Error('請選擇分倉作為來源，目的地固定為主倉。');
    let saved;
    await runRoleTransaction(async tx=>{
        const ref=db.collection('stockTransferRequests').doc(id),prior=await tx.get(ref);
        if(prior.exists){saved=prior.data();if(saved.inventoryId!==inventoryId||saved.fromWarehouseId!==fromWarehouseId||saved.toWarehouseId!==toWarehouseId||Number(saved.qty)!==qty)throw Error('調回操作識別碼衝突。');return;}
        const invRef=db.collection('inventory').doc(inventoryId),invSnap=await tx.get(invRef);
        if(!invSnap.exists)throw Error('找不到庫存。');const inv=invSnap.data(),key=inv.productKey||inv.productId;
        if(!key)throw Error('庫存缺少產品識別。');
        const stockRef=db.collection('warehouseStocks').doc(warehouseStockDocId(fromWarehouseId,key));
        const stockSnap=await tx.get(stockRef),source=await tx.get(db.collection('warehouses').doc(fromWarehouseId)),target=await tx.get(db.collection('warehouses').doc(toWarehouseId));
        if(!stockSnap.exists||!source.exists||source.data().active===false||source.data().systemCustody||!target.exists||target.data().active===false||!target.data().isDefault||target.data().systemCustody)throw Error('主倉或來源分倉設定不正確。');
        const hold=globalThis.YushinReservation.planMainTransferHold({qty,aggregateStock:inv,warehouseStock:stockSnap.data()});
        if(actorUid!==currentUser.uid||actorRole!==currentUserRole||!canManageInventoryStockPolicy()||!canEditPage('inventory'))throw Error('登入身分已變更。');
        saved={id,inventoryId,productKey:key,productId:inv.productId||key,itemCode:inv.itemCode||'',itemName:inv.itemName||'',brand:inv.brand||'',fromWarehouseId,toWarehouseId,fromStockId:stockRef.id,qty,status:'PENDING',createdByUid:actorUid,createdAt:now};
        tx.set(ref,saved);
        tx.update(stockRef,{...hold.warehouse,updatedAt:now});
        tx.update(invRef,{...hold.aggregate,updatedAt:now});
    });
    return saved;
}

async function cancelMainTransferRequestRecord(id) {
    if(!canManageInventoryStockPolicy()||!canEditPage('inventory'))throw Error('只有採購或管理員可取消主倉備貨需求。');
    const actorUid=currentUser.uid,actorRole=currentUserRole,now=new Date().toISOString();
    let saved;
    await runRoleTransaction(async tx=>{
        const ref=db.collection('stockTransferRequests').doc(id),snapshot=await tx.get(ref);
        if(!snapshot.exists)throw Error('調回需求不存在。');const request=snapshot.data();
        if(request.status==='CANCELLED'){saved=request;return;}
        if(request.status!=='PENDING')throw Error('已寄出的調撥不能取消需求。');
        const stockRef=db.collection('warehouseStocks').doc(request.fromStockId),invRef=db.collection('inventory').doc(request.inventoryId);
        const stock=await tx.get(stockRef),inventory=await tx.get(invRef);
        if(!stock.exists||!inventory.exists)throw Error('庫存不存在。');
        const release=globalThis.YushinReservation.planMainTransferHold({qty:request.qty,release:true,aggregateStock:inventory.data(),warehouseStock:stock.data()});
        if(actorUid!==currentUser.uid||actorRole!==currentUserRole||!canManageInventoryStockPolicy()||!canEditPage('inventory'))throw Error('登入身分已變更。');
        const updates={status:'CANCELLED',cancelledAt:now,cancelledByUid:actorUid};
        tx.update(ref,updates);
        tx.update(stockRef,{...release.warehouse,updatedAt:now});
        tx.update(invRef,{...release.aggregate,updatedAt:now});
        saved={...request,...updates};
    });
    return saved;
}
