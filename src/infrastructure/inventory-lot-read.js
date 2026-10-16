// Read-only bounded adapters. Never project embedded inventory.lots or fetch cost.
async function readInventoryLotQueryPage(query,{cursor=null,pageSize=100,assertContext=()=>{}}={}) {
    if(!Number.isInteger(pageSize)||pageSize<1||pageSize>100)throw new Error('批次分頁大小不正確。');
    assertContext();
    if(cursor)query=query.startAfter(cursor);
    const snapshot=await firestoreReadWithTimeout(query.limit(pageSize+1).get(),'庫存批次分頁');
    assertContext();
    const docs=snapshot.docs.slice(0,pageSize);
    return {rows:YushinInventory.operationalLotRows(docs.map(doc=>({...doc.data(),id:doc.id}))),cursor:docs.at(-1)||cursor,hasMore:snapshot.size>pageSize};
}
async function readInventoryLotsForProducts(productKeys,options={}) {
    const keys=[...new Set(productKeys.filter(key=>typeof key==='string'&&key.trim()))];
    if(!keys.length||keys.length>30)throw new Error('每次批次查詢需有 1 至 30 個產品。');
    return readInventoryLotQueryPage(db.collection('inventoryLots').where('productKey','in',keys),options);
}
async function readInventoryLotMatches(value,field='lotNo',options={}) {
    if(!['lotNo','expiryDate'].includes(field)||typeof value!=='string'||!value.trim())throw new Error('批次搜尋條件不正確。');
    return readInventoryLotQueryPage(db.collection('inventoryLots').where(field,'==',value.trim()),options);
}
async function readInventoryForLotProducts(productKeys,{assertContext=()=>{}}={}) {
    const keys=[...new Set(productKeys)];
    if(keys.length>100)throw new Error('批號搜尋產品超過單頁上限。');
    assertContext();
    const pages=await Promise.all(Array.from({length:Math.ceil(keys.length/30)},async(_,index)=>{
        const page=await firestoreReadWithTimeout(db.collection('inventory').where('productKey','in',keys.slice(index*30,index*30+30)).limit(101).get(),'批號對應庫存');
        assertContext();
        if(page.size>100)throw new Error('同產品庫存文件過多，無法完整確認。');
        return page.docs.map(doc=>({...doc.data(),id:doc.id}));
    }));
    return pages.flat();
}
