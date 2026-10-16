// Quantity counting owns stock/lot/movement writes; the Feature owns the form
// and retains the operation ID while a commit response is uncertain.
async function commitInventoryQuantity(input,{actorUid=currentUser?.uid,actorRole=currentUserRole,actorName=currentUserName||currentUser?.email||'',onStockCommitted=null}={}) {
    const assertActor=()=>{
        if(!actorUid||actorUid!==currentUser?.uid||actorRole!==currentUserRole)throw new Error('登入帳號或角色已變更，請以原身分確認盤點結果。');
        if(!['admin','purchaser','warehouse'].includes(actorRole))throw new Error('目前沒有庫存盤點權限。');
    };
    assertActor();
    const request=JSON.parse(JSON.stringify(input||{}));
    const {item={},warehouseId,target,operationId,singleWarehouseFallback=false}=request;
    const key=String(item.productKey||item.productId||'').trim();
    const inventoryId=item.id||encodeURIComponent(key),note=String(request.note||'').trim();
    const validId=value=>typeof value==='string'&&value.trim()!==''&&!value.includes('/');
    if(!key||!validId(inventoryId)||!validId(warehouseId)||!validId(operationId))throw new Error('缺少有效的產品、倉庫或盤點操作識別碼。');
    if(typeof target!=='number'||!Number.isFinite(target)||target<0)throw new Error('盤點後現有數量必須是 0 或正數。');
    const number=(value,label)=>{
        if(value===undefined)return 0;
        if(!['number','string'].includes(typeof value)||String(value).trim()===''||!Number.isFinite(Number(value))||Number(value)<0)throw new Error(label+'數量不正確，請先核對庫存。');
        return Number(value);
    };
    const stock=(data,label)=>{
        const result=Object.fromEntries(['onHand','reserved','incoming'].map(field=>[field,number(data[field],label+field)]));
        if(result.reserved>result.onHand)throw new Error(label+'已預留超過現有數量，請先核對庫存。');
        return result;
    };
    const assertIdentity=(data,warehouse='')=>{
        if((data.productKey&&data.productKey!==key)||(data.productId&&data.productId!==key)||(warehouse&&data.warehouseId&&data.warehouseId!==warehouse))throw new Error('庫存產品或倉庫識別不符，請先核對資料。');
    };
    const now=new Date().toISOString();
    const ref=db.collection('inventory').doc(inventoryId);
    const whRef=db.collection('warehouseStocks').doc(warehouseStockDocId(warehouseId,key));
    const movementRef=db.collection('inventoryMovements').doc(operationId);
    const balanceRef=db.collection('inventoryLots').doc(operationId+'-balance');
    const addedRef=db.collection('inventoryLots').doc(operationId+'-added');
    let result;
    await runRoleTransaction(async tx=>{
        assertActor();result=undefined;
        const movementSnap=await tx.get(movementRef);assertActor();
        if(movementSnap.exists){
            const saved=movementSnap.data();
            if(saved.operation!=='quantity-editor'||saved.sourceId!==operationId||saved.productKey!==key||saved.warehouseId!==warehouseId
                ||saved.countInventoryId!==inventoryId||saved.countTarget!==target||saved.note!==note||saved.actorUid!==actorUid||saved.actorRole!==actorRole
                ||typeof saved.qty!=='number'||!Number.isFinite(saved.qty))throw new Error('盤點操作識別碼已用於不同內容或身分，請先確認原作業。');
            result={delta:saved.qty,productKey:key,warehouseId,operationId,replayed:true};return;
        }
        const invSnap=await tx.get(ref),whSnap=await tx.get(whRef);assertActor();
        if(!invSnap.exists)throw new Error('庫存資料已不存在，請重新整理。');
        const old=invSnap.data()||{},whData=whSnap.exists?whSnap.data():{};
        assertIdentity(old);assertIdentity(whData,warehouseId);
        const n=stock(old,'公司'),wh=stock(whData,'分倉');
        const effectiveWarehouse=!whSnap.exists&&singleWarehouseFallback===true?n:wh;
        const current=effectiveWarehouse.onHand;
        const delta=target-current;
        if(current>n.onHand)throw new Error('分倉數量超過公司總量，請先核對庫存。');
        if(target<effectiveWarehouse.reserved||n.onHand+delta<n.reserved)throw new Error('盤點數量不可小於已預留數量。');
        result={delta,productKey:key,warehouseId,operationId,replayed:false};
        const audit={type:'adjustment',qty:delta,productKey:key,productId:old.productId||item.productId||key,warehouseId,sourceType:'manual',sourceId:operationId,operation:'quantity-editor',countInventoryId:inventoryId,countTarget:target,actorUid,actorRole,note,createdAt:now,createdBy:actorName};
        // Even an unchanged count needs a receipt: an uncertain reply must not let
        // the same operation overwrite a later arrival on its next attempt.
        if(delta===0){tx.set(movementRef,{...audit,lotAllocations:[],lotIds:[]});return;}
        const lotQuery=await firestoreReadWithTimeout(db.collection('inventoryLots').where('productKey','==',key).where('warehouseId','==',warehouseId).limit(201).get(),'盤點批次');
        assertActor();
        if(lotQuery.size>200)throw new Error('批次超過安全處理上限。');
        const lotSnaps=await Promise.all(lotQuery.docs.map(doc=>tx.get(doc.ref)));
        const currentLots=lotSnaps.filter(doc=>doc.exists).map(doc=>({...doc.data(),id:doc.id}));
        for(const lot of currentLots){assertIdentity(lot,warehouseId);number(lot.remainingQty??lot.qty,'批次');}
        const balanceSnap=await tx.get(balanceRef),addedSnap=await tx.get(addedRef);assertActor();
        if(balanceSnap.exists||addedSnap.exists)throw new Error('盤點操作識別碼衝突，請先確認原作業。');
        const lotPlan=YushinInventory.quantityAdjustmentLots(currentLots,current,target,effectiveWarehouse.reserved,balanceRef.id,addedRef.id);
        const canonicalBrand=resolveBrandName(old.brand||item.brand||'');
        const metadata={productKey:key,productId:old.productId||item.productId||key,itemCode:old.itemCode||item.itemCode||'',itemName:old.itemName||item.itemName||'',brand:canonicalBrand,brandId:old.brandId||item.brandId||brandIdForName(canonicalBrand)};
        const nextInventory={...old,...metadata,onHand:n.onHand+delta,reserved:n.reserved,incoming:n.incoming,updatedAt:now};
        nextInventory.searchTokens=buildInventorySearchTokens(nextInventory);
        assertActor();
        for(const lot of lotPlan.lots){
            const oldLot=currentLots.find(row=>row.id===lot.id),lotRef=db.collection('inventoryLots').doc(lot.id);
            if(oldLot){
                if(Number(oldLot.remainingQty??oldLot.qty)!==lot.remainingQty)tx.update(lotRef,{remainingQty:lot.remainingQty,updatedAt:now});
            }else tx.set(lotRef,{productKey:key,productId:metadata.productId,warehouseId,lotNo:'',expiryDate:'',receivedQty:lot.receivedQty,remainingQty:lot.remainingQty,unbatched:true,sourceType:lot.id===balanceRef.id?'MANUAL_STOCK_BALANCE':'MANUAL_ADJUSTMENT',sourceId:operationId,receivedAt:now,createdBy:actorName});
        }
        tx.set(ref,nextInventory,{merge:true});
        tx.set(whRef,{...metadata,warehouseId,onHand:target,reserved:effectiveWarehouse.reserved,incoming:effectiveWarehouse.incoming,updatedAt:now},{merge:true});
        tx.set(movementRef,{...audit,...metadata,lotAllocations:lotPlan.allocations,lotIds:lotPlan.lots.filter(lot=>!currentLots.some(row=>row.id===lot.id)).map(lot=>lot.id)});
    });
    try{
        assertActor();
        if(result.delta!==0)onStockCommitted?.(key,warehouseId);
    }catch(err){err.inventoryCountCommitted=true;err.operationId=operationId;throw err;}
    return result;
}
