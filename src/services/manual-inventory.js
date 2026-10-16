// One row is an atomic checkpoint; batch presentation and recovery IDs belong to the Feature.
async function commitManualInventoryAdjustment(input,{actorUid=currentUser?.uid,actorRole=currentUserRole,actorName=currentUserName||currentUser?.email||'',onStockCommitted=null}={}) {
    const assertActor=()=>{
        if(!actorUid||actorUid!==currentUser?.uid||actorRole!==currentUserRole)throw new Error('登入帳號或角色已變更，請以原身分確認庫存異動結果。');
        if(!['admin','purchaser','warehouse'].includes(actorRole))throw new Error('目前沒有人工庫存異動權限。');
    };
    assertActor();
    const request=JSON.parse(JSON.stringify(input||{})),{type,productKey:key,warehouseId,operationId}=request;
    const row=request.row||{},validId=value=>typeof value==='string'&&value.trim()!==''&&!value.includes('/');
    if(!['initial','adjustment','scrap'].includes(type)||!validId(key)||!validId(warehouseId)||!validId(operationId))throw new Error('缺少有效的異動類型、產品、倉庫或操作識別碼。');
    if(typeof row.qty!=='number'||!Number.isFinite(row.qty)||row.qty===0||(type==='initial'&&row.qty<0))throw new Error('庫存異動數量不正確；新增庫存必須是正數。');
    const delta=type==='scrap'?-Math.abs(row.qty):row.qty,lotNo=String(row.lotNo||'').trim(),expiryDate=String(row.expiryDate||'').trim();
    if(expiryDate&&(!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate)||!Number.isFinite(Date.parse(expiryDate))||new Date(expiryDate).toISOString().slice(0,10)!==expiryDate))throw new Error('效期格式不正確。');
    const writesCost=type==='initial'&&['admin','purchaser'].includes(actorRole);
    if(writesCost&&(String(row.unitCost??'').trim()===''||!['number','string'].includes(typeof row.unitCost)||!Number.isFinite(Number(row.unitCost))||Number(row.unitCost)<0))throw new Error('手動新增庫存請填寫實際單位成本，零成本請明確填 0。');
    const intent={type,productKey:key,warehouseId,delta,lotNo,expiryDate};
    const stock=data=>{
        const result={};
        for(const field of ['onHand','reserved','incoming']){
            const value=data[field]===undefined?0:data[field];
            if(!['number','string'].includes(typeof value)||String(value).trim()===''||!Number.isFinite(Number(value))||Number(value)<0)throw new Error('原庫存數量不正確，請先核對資料。');
            result[field]=Number(value);
        }
        if(result.reserved>result.onHand)throw new Error('已預留超過現有數量，請先核對庫存。');
        return result;
    };
    const identity=(data,warehouse='')=>{
        if((data.productKey&&data.productKey!==key)||(data.productId&&data.productId!==key)||(warehouse&&data.warehouseId&&data.warehouseId!==warehouse))throw new Error('產品或倉庫識別不符，請先核對資料。');
    };
    const ref=db.collection('inventory').doc(encodeURIComponent(key)),whRef=db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,key));
    const movementRef=db.collection('inventoryMovements').doc(operationId),balanceRef=db.collection('inventoryLots').doc(operationId+'-balance'),addedRef=db.collection('inventoryLots').doc(operationId+'-added');
    const costRef=db.collection('inventoryLotCosts').doc(addedRef.id),now=new Date().toISOString();
    let result;
    await runRoleTransaction(async tx=>{
        assertActor();result=undefined;
        const prior=await tx.get(movementRef);assertActor();
        if(prior.exists){
            const saved=prior.data();
            if(saved.operation!=='manual-adjustment'||saved.sourceId!==operationId||saved.actorUid!==actorUid||saved.actorRole!==actorRole
                ||saved.type!==type||saved.qty!==delta||saved.productKey!==key||saved.warehouseId!==warehouseId
                ||!Object.keys(intent).every(field=>saved.adjustmentIntent?.[field]===intent[field]))throw new Error('此操作識別碼已用於不同內容或身分，請先確認原異動。');
            if(writesCost){
                const cost=await tx.get(costRef);assertActor();
                if(!cost.exists||cost.data().unitCost!==Number(row.unitCost)||cost.data().lotId!==addedRef.id||cost.data().productKey!==key)throw new Error('原新增庫存成本已變更或不符，請先確認原異動。');
            }
            result={operationId,productKey:key,warehouseId,delta,replayed:true};return;
        }
        const productSnap=await tx.get(db.collection('products').doc(key)),warehouseSnap=await tx.get(db.collection('warehouses').doc(warehouseId));
        const invSnap=await tx.get(ref),whSnap=await tx.get(whRef);assertActor();
        if(!productSnap.exists||productSnap.data().active===false||productSnap.data().status==='INACTIVE')throw new Error('產品主檔不存在或已停用。');
        if(!warehouseSnap.exists||warehouseSnap.data().active===false||warehouseSnap.data().systemCustody||warehouseSnap.data().warehouseType==='CUSTODY'||warehouseId.startsWith('custody-'))throw new Error('請選擇有效的實體倉庫，不可直接異動保管庫存。');
        const product=productSnap.data();
        if(['service','services','服務'].includes(String(product.productType||'').trim().toLowerCase()))throw new Error('服務品項不可建立實體庫存異動。');
        if((product.productId&&product.productId!==key)||(product.lotTracked&&!lotNo)||(product.expiryTracked&&!expiryDate))throw new Error('產品識別或必填批號／效期不符。');
        const old=invSnap.exists?invSnap.data():{},oldWh=whSnap.exists?whSnap.data():{};identity(old);identity(oldWh,warehouseId);
        const n=stock(old),wh=stock(oldWh);
        if(wh.onHand>n.onHand||n.onHand+delta<n.reserved||wh.onHand+delta<wh.reserved)throw new Error('異動後庫存不足以支撐已預留數量，或公司與分倉數量不符。');
        const query=await firestoreReadWithTimeout(db.collection('inventoryLots').where('productKey','==',key).limit(201).get(),'人工異動批次');assertActor();
        if(query.size>200)throw new Error('此產品批次超過安全處理上限。');
        const snaps=await Promise.all(query.docs.map(doc=>tx.get(doc.ref)));
        const allLots=snaps.filter(doc=>doc.exists).map(doc=>({...doc.data(),id:doc.id}));
        for(const lot of allLots){identity(lot);if(!validId(lot.warehouseId))throw new Error('批次缺少有效的倉庫識別。');const qty=lot.remainingQty??lot.qty??0;if(!['number','string'].includes(typeof qty)||String(qty).trim()===''||!Number.isFinite(Number(qty))||Number(qty)<0)throw new Error('批次數量不正確。');}
        const balance=await tx.get(balanceRef),added=await tx.get(addedRef),cost=writesCost?await tx.get(costRef):null;assertActor();
        if(balance.exists||added.exists||cost?.exists)throw new Error('庫存異動的批次或成本識別碼衝突。');
        const currentLots=allLots.filter(lot=>lot.warehouseId===warehouseId);
        const plan=YushinInventory.manualAdjustmentLots(currentLots,wh.onHand,delta,wh.reserved,{lotNo,expiryDate,balanceId:balanceRef.id,addedId:addedRef.id});
        const brand=resolveBrandName(product.brandName||product.brand||row.brand||'');
        const metadata={productKey:key,productId:key,itemCode:product.manufacturerPartNo||product.model||row.itemCode||'',itemName:product.productName||product.nameCn||product.nameEn||row.itemName||'',brand,brandId:product.brandId||brandIdForName(brand)};
        // Legacy list/search mirror is a projection of operational lots, never an independent delta ledger.
        const lots=[...allLots.filter(lot=>lot.warehouseId!==warehouseId),...plan.lots.map(lot=>({...lot,warehouseId}))].map(lot=>({warehouseId:lot.warehouseId,lotNo:lot.lotNo||'',expiryDate:lot.expiryDate||'',qty:Number(lot.remainingQty??lot.qty??0)}));
        const nextInventory={...old,...metadata,onHand:n.onHand+delta,reserved:n.reserved,incoming:n.incoming,lots,updatedAt:now};
        nextInventory.searchTokens=buildInventorySearchTokens(nextInventory);assertActor();
        for(const lot of plan.lots){
            const existing=currentLots.find(row=>row.id===lot.id),lotRef=db.collection('inventoryLots').doc(lot.id);
            if(existing){if(Number(existing.remainingQty??existing.qty??0)!==lot.remainingQty)tx.update(lotRef,{remainingQty:lot.remainingQty,updatedAt:now});}
            else tx.set(lotRef,{productKey:key,productId:key,warehouseId,lotNo:lot.lotNo||'',expiryDate:lot.expiryDate||'',receivedQty:lot.receivedQty,remainingQty:lot.remainingQty,unbatched:lot.unbatched===true,
                sourceType:lot.id===balanceRef.id?'MANUAL_STOCK_BALANCE':type==='initial'?'INITIAL_STOCK':'MANUAL_ADJUSTMENT',sourceId:operationId,receivedAt:now,createdBy:actorName});
        }
        if(type==='initial')tx.set(costRef,{lotId:addedRef.id,productKey:key,productId:key,warehouseId,...(writesCost?{unitCost:Number(row.unitCost)}:{costPending:true}),sourceType:'INITIAL_STOCK',sourceId:operationId,createdAt:now,createdBy:actorName});
        tx.set(ref,nextInventory,{merge:true});
        tx.set(whRef,{...metadata,warehouseId,onHand:wh.onHand+delta,reserved:wh.reserved,incoming:wh.incoming,updatedAt:now},{merge:true});
        tx.set(movementRef,{type,qty:delta,...metadata,warehouseId,lotNo,expiryDate,lotId:delta>0?addedRef.id:'',lotAllocations:plan.allocations,operation:'manual-adjustment',adjustmentIntent:intent,
            actorUid,actorRole,sourceType:'manual',sourceId:operationId,createdAt:now,createdBy:actorName});
        result={operationId,productKey:key,warehouseId,delta,replayed:false};
    });
    try{assertActor();onStockCommitted?.(key,warehouseId);}catch(err){err.manualAdjustmentCommitted=true;err.operationId=operationId;throw err;}
    return result;
}
