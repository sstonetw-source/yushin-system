// One authoritative order document commit. Features own drafts, IDs and presentation;
// inventory initialization and delayed quote/source synchronization remain checkpoints.
async function commitOrderCreation(orderId,data,{actorUid=currentUser?.uid,actorRole=currentUserRole,linkForecast=false,expectedForecastUpdatedAt=''}={}) {
    const assertActor=()=>{
        if(!actorUid||actorUid!==currentUser?.uid||actorRole!==currentUserRole)throw new Error('登入帳號或角色已變更，請以原身分確認建單結果。');
        if(!['admin','sales','engineer','purchaser'].includes(actorRole))throw new Error('目前沒有建立訂單權限。');
    };
    assertActor();
    if(typeof orderId!=='string'||!orderId.trim()||orderId.includes('/'))throw new Error('缺少有效的建單識別碼。');
    if(!data||data.createdByUid!==actorUid||data.status!==BUSINESS_STATUS.ACTIVE)throw new Error('建單身分或初始狀態不正確。');
    const snapshot=JSON.parse(JSON.stringify(data));
    const reorder=snapshot.returnReorderSource;
    if(reorder!==undefined&&(!reorder||typeof reorder!=='object'||Array.isArray(reorder)
        ||Object.keys(reorder).length!==1||typeof reorder.orderId!=='string'||!reorder.orderId
        ||reorder.orderId!==reorder.orderId.trim()||reorder.orderId.includes('/')||reorder.orderId.length>160
        ||reorder.orderId===orderId||linkForecast||snapshot.sourceType||snapshot.sourceId))
        throw new Error('退貨重新下單的來源關聯不正確。');
    if(linkForecast&&(snapshot.sourceType!==DOCUMENT_TYPES.FORECAST||!snapshot.sourceId||snapshot.sourceDocumentSyncStatus!=='completed'))
        throw new Error('Forecast 建單來源與同步狀態不符。');
    if(!linkForecast&&snapshot.sourceDocumentSyncStatus==='completed')throw new Error('來源同步完成必須具有同交易的來源連結。');
    let savedData;
    const ref=db.collection('orders').doc(orderId);
    await runRoleTransaction(async tx=>{
        assertActor();savedData=undefined;
        const existing=await tx.get(ref);
        assertActor();
        if(existing.exists){
            const live=existing.data();
            if(live.createdByUid!==actorUid||live.status!==BUSINESS_STATUS.ACTIVE||['cancelled','voided'].includes(live.orderStatus))
                throw new Error('待確認的訂單已由其他流程變更，請先檢查訂單清單。');
            if(linkForecast&&(live.sourceType!==snapshot.sourceType||live.sourceId!==snapshot.sourceId))
                throw new Error('建單識別碼已用於其他來源，請先核對原訂單。');
            if(JSON.stringify(live.returnReorderSource||null)!==JSON.stringify(reorder||null))
                throw new Error('建單識別碼已用於其他退貨來源，請先核對原訂單。');
            // Preserve the existing pending-ID contract: resume authoritative saved
            // facts, not a modified/stale form, and never overwrite fulfillment progress.
            savedData=live;return;
        }
        if((snapshot.items || []).length>15)throw new Error('每張訂單最多 15 個品項；請分成多張訂單後再儲存。');
        const tradeValidation=globalThis.YushinOrderEntry.validateTrade(snapshot,{requireInvoiceTitle:false});
        if(!tradeValidation.valid)throw new Error(tradeValidation.message);
        let forecastRef=null;
        if(reorder){
            const source=await tx.get(db.collection('orders').doc(reorder.orderId));assertActor();
            if(!source.exists)throw new Error('原退貨訂單不存在，請重新核對來源。');
            const original=source.data();
            if((!['admin','purchaser'].includes(actorRole)&&original.ownerUid!==actorUid)
                ||original.customerName!==snapshot.customerName)throw new Error('原退貨訂單的負責人或客戶不符。');
            if(!Array.isArray(original.returnRecords)||!original.returnRecords.some(row=>row?.settlement==='CLOSE'
                &&Number.isFinite(Number(row.qty))&&Number(row.qty)>0))throw new Error('原訂單尚無實收結案退貨，不能由此重新下單。');
        }
        if(linkForecast){
            if(!['sales','admin'].includes(actorRole))throw new Error('目前沒有 Forecast 轉單權限。');
            forecastRef=db.collection('forecasts').doc(snapshot.sourceId);
            const source=await tx.get(forecastRef);assertActor();
            if(!source.exists)throw new Error('來源 Forecast 已不存在，不能建立未連結的訂單。');
            const forecast=source.data();
            if(normalizedOrderStatus(forecast)!=='normal')throw new Error('來源 Forecast 已取消／作廢，不能轉單。');
            if((actorRole!=='admin'&&forecast.ownerUid&&forecast.ownerUid!==actorUid)
                ||snapshot.ownerUid!==(forecast.ownerUid||actorUid))throw new Error('Forecast 與訂單負責人不符，請重新核對來源。');
            if(expectedForecastUpdatedAt&&forecast.updatedAt!==expectedForecastUpdatedAt)throw new Error('Forecast 已變更，請重新整理後核對轉單內容。');
        }
        assertActor();
        tx.set(ref,snapshot);
        if(forecastRef)tx.update(forecastRef,{
            linkedDocuments:firebase.firestore.FieldValue.arrayUnion(documentLink(DOCUMENT_TYPES.ORDER,orderId,'created')),
            updatedAt:snapshot.createdAt
        });
        savedData=snapshot;
    });
    try{assertActor();}catch(err){err.orderCommitted=true;err.orderId=orderId;throw err;}
    return {id:orderId,data:savedData};
}
