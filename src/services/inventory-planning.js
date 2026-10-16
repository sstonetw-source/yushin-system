// Planning/list flags never mutate physical stock. Audit IDs are operation receipts.
async function commitInventoryPlanningSettings(inventoryId,policy,safetyStock=0,{operationId,actorUid=currentUser?.uid,actorRole=currentUserRole}={}) {
    const assertActor=()=>{
        if(!actorUid||currentUser?.uid!==actorUid||currentUserRole!==actorRole)throw new Error('登入身分已變更，請以原身分確認庫存設定。');
        if(!['admin','purchaser'].includes(actorRole))throw new Error('只有管理員或採購可以調整庫存策略。');
    };
    assertActor();
    const settings=YushinInventory.planningSettings(policy,safetyStock);
    if(typeof inventoryId!=='string'||!inventoryId.trim()||inventoryId.length>128||inventoryId.includes('/'))throw new Error('庫存識別碼不正確。');
    if(typeof operationId!=='string'||!operationId.trim()||operationId.length>128||operationId.includes('/'))throw new Error('缺少有效的庫存設定操作識別碼。');
    const ref=db.collection('inventory').doc(inventoryId),auditRef=db.collection('auditLogs').doc(operationId),at=new Date().toISOString();
    let result;
    await runRoleTransaction(async tx=>{
        assertActor();result=undefined;
        const audit=await tx.get(auditRef),snapshot=await tx.get(ref);assertActor();
        if(!snapshot.exists)throw new Error('找不到庫存品項，請更新清單。');
        const live=snapshot.data();
        if(audit.exists){
            const saved=audit.data();
            if(saved.action!=='inventory_policy_set'||saved.inventoryId!==inventoryId||saved.actorUid!==actorUid||saved.actorRole!==actorRole
                ||saved.stockPolicy!==settings.stockPolicy||saved.safetyStock!==settings.safetyStock)throw new Error('此設定操作識別碼已用於其他內容或身分，請先確認原作業。');
            // The receipt proves the earlier intent, not that the policy never changed again.
            const current=YushinInventory.planningSettings(YushinInventory.stockPolicyFor(live),live.safetyStock??0);
            result={patch:{...current,...(live.updatedAt?{updatedAt:live.updatedAt}:{})},replayed:true,changed:false,operationId};return;
        }
        const changed=live.stockPolicy!==settings.stockPolicy||live.safetyStock!==settings.safetyStock;
        const patch={...settings,updatedAt:at};
        if(changed)tx.update(ref,patch);
        tx.set(auditRef,{action:'inventory_policy_set',inventoryId,actorUid,actorRole,...settings,
            previousStockPolicy:live.stockPolicy??null,previousSafetyStock:live.safetyStock??null,changed,createdAt:at});
        result={patch:changed?patch:{...settings,...(live.updatedAt?{updatedAt:live.updatedAt}:{})},replayed:false,changed,operationId};
    });
    try{assertActor();}catch(err){err.inventoryPlanningCommitted=true;err.operationId=operationId;throw err;}
    return result;
}

async function commitInventoryListArchive({inventoryId,productKey,archived,operationId},{actorUid=currentUser?.uid,actorRole=currentUserRole}={}) {
    const assertActor=()=>{
        if(!actorUid||currentUser?.uid!==actorUid||currentUserRole!==actorRole)throw new Error('登入身分已變更，請以原身分確認庫存列表。');
        if(actorRole!=='admin'||trueUserRole!=='admin')throw new Error('只有管理員視角可以移出或恢復庫存品項。');
    };
    assertActor();
    const valid=value=>typeof value==='string'&&value.trim()!==''&&value.length<=128&&!value.includes('/');
    if(!valid(inventoryId)||!productKey||typeof productKey!=='string'||!valid(operationId)||typeof archived!=='boolean')throw new Error('庫存列表操作資料不正確。');
    const ref=db.collection('inventory').doc(inventoryId),auditRef=db.collection('auditLogs').doc(operationId),at=new Date().toISOString();
    let result;
    await runRoleTransaction(async tx=>{
        assertActor();result=undefined;
        const audit=await tx.get(auditRef),snapshot=await tx.get(ref);assertActor();
        if(!snapshot.exists)throw new Error('找不到庫存品項，請更新清單。');
        const live=snapshot.data();
        if((live.productKey||live.productId||inventoryId)!==productKey)throw new Error('品項識別已變更，請先核對資料。');
        if(audit.exists){
            const saved=audit.data();
            if(saved.action!==(archived?'inventory_list_archive':'inventory_list_restore')||saved.inventoryId!==inventoryId||saved.productKey!==productKey
                ||saved.archived!==archived||saved.actorUid!==actorUid||saved.actorRole!==actorRole)throw new Error('此列表操作識別碼已用於其他內容或身分，請先確認原作業。');
            const patch={listArchived:live.listArchived===true};
            for(const key of ['listArchiveChangedAt','listArchiveChangedByUid','listArchiveAuditId','updatedAt'])if(live[key]!==undefined)patch[key]=live[key];
            result={patch,replayed:true,changed:false,operationId};return;
        }
        if(archived){
            if(!YushinInventory.stockIsEmpty({...live,lots:[]}))throw new Error('庫存、預留、在途或調撥數量不為零，不能移出。');
            // Repeat discovery on every callback attempt, then re-read each document
            // transactionally. Inactive warehouses are deliberately included.
            const [warehouses,lots]=await Promise.all([
                firestoreReadWithTimeout(db.collection('warehouseStocks').where('productKey','==',productKey).limit(201).get(),'移出前檢查倉庫庫存'),
                firestoreReadWithTimeout(db.collection('inventoryLots').where('productKey','==',productKey).limit(201).get(),'移出前檢查實際批次')
            ]);assertActor();
            if(warehouses.size>200||lots.size>200)throw new Error('批次或倉庫紀錄超過安全檢查上限。');
            for(const doc of lots.docs){
                const lot=await tx.get(doc.ref);assertActor();
                if(!lot.exists)continue;
                const data=lot.data(),qty='remainingQty' in data?data.remainingQty:data.qty;
                if(data.productKey!==productKey||qty===undefined||!YushinInventory.stockIsEmpty({onHand:qty}))throw new Error('仍有實際批次剩餘量或無效批次，不能移出。');
            }
            for(const doc of warehouses.docs){
                const stock=await tx.get(doc.ref);assertActor();
                if(stock.exists&&(stock.data().productKey!==productKey||!YushinInventory.stockIsEmpty(stock.data())))throw new Error('仍有倉庫庫存、預留、在途或無效數量，不能移出。');
            }
        }
        assertActor();
        const changed=(live.listArchived===true)!==archived;
        const patch=changed?{listArchived:archived,listArchiveChangedAt:at,listArchiveChangedByUid:actorUid,listArchiveAuditId:operationId,updatedAt:at}:{listArchived:archived};
        if(changed)tx.update(ref,patch);
        tx.set(auditRef,{action:archived?'inventory_list_archive':'inventory_list_restore',inventoryId,productKey,actorUid,actorRole,createdAt:at,
            itemCode:live.itemCode||'',itemName:live.itemName||'',archived,changed});
        result={patch,replayed:false,changed,operationId};
    });
    try{assertActor();}catch(err){err.inventoryListCommitted=true;err.operationId=operationId;throw err;}
    return result;
}
