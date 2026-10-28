// Transaction service shared by both dispatch UI entrances. A frozen attempt
// identifies paperwork only; inventory, shipment and customer delivery do not change.
function dispatchBackendPilotEnabled() {
    return globalThis.YUSHIN_V2_DISPATCH_EMULATOR===true
        || (typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='preview'
            &&globalThis.YUSHIN_PREVIEW_DISPATCH===true);
}
async function prepareV2OrderDispatchBackend(orderId,itemId,intent,assertActor) {
    const local=host=>['localhost','127.0.0.1'].includes(host);
    const emulator=globalThis.YUSHIN_V2_DISPATCH_EMULATOR===true;
    const preview=typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='preview'
        &&globalThis.YUSHIN_PREVIEW_DISPATCH===true;
    const host=String(globalThis.location?.hostname||'').toLowerCase();
    if((!emulator&&!preview)||(emulator&&!local(host))
        ||(preview&&!['preview-20135.web.app','preview-20135.firebaseapp.com'].includes(host))
        ||typeof firebase==='undefined'||!firebase.auth||!firebase.functions)
        throw new Error('出貨準備後端尚未在目前授權的測試環境啟用，禁止改用舊交易。');
    const auth=firebase.auth(),functions=firebase.app().functions('asia-east1');
    const project=emulator?'demo-yushin':'preview-20135';
    if(firebase.app().options?.projectId!==project
        ||auth.app?.options?.projectId!==project||functions.app?.options?.projectId!==project
        ||typeof db==='undefined'||db.app?.options?.projectId!==project
        ||(emulator&&(!local(auth.emulatorConfig?.host)||auth.emulatorConfig?.port!==9099))
        ||(preview&&!!auth.emulatorConfig))
        throw new Error('出貨準備 Auth、Functions 與資料庫專案不一致，未提交打單。');
    const assertSession=()=>{assertActor();if(auth.currentUser?.uid!==intent.actorUid)
        throw new Error('實際登入帳號已變更，請以原身分確認打單結果。');};
    assertSession();
    if(typeof intent.syncAttemptId!=='string'||!intent.syncAttemptId||intent.syncAttemptId.length>96)
        throw new Error('缺少原 v2 同步識別碼，請保留原作業並重新核對。');
    if(emulator)functions.useEmulator('127.0.0.1',5001);
    let reply;
    try{reply=await functions.httpsCallable('prepareV2OrderDispatch')({orderId,itemId,
        quantity:intent.quantity,operationId:intent.operationId,syncAttemptId:intent.syncAttemptId,
        expectedPreparedQty:intent.expectedPreparedQty});}
    catch(error){
        if(error.code==='functions/failed-precondition'&&error.details?.reason==='dispatch-stale'){
            const stale=new Error(error.message);stale.code='dispatch-stale';throw stale;
        }
        throw error;
    }
    assertSession();const result=reply?.data;
    if(!['applied','already-applied'].includes(result?.status)||result.orderId!==orderId||result.itemId!==itemId
        ||result.qty!==intent.quantity||result.recordId!=='v2-'+intent.operationId)
        throw new Error('v2 打單回覆不明確，請保留原識別碼重試。');
    // Refresh actual source data; never synthesize an order from result counters.
    const source=await db.collection('orders').doc(orderId).get({source:'server'});assertSession();
    if(!source.exists)throw new Error('打單可能已提交，但找不到最新訂單，請以原識別碼重試。');
    return source.data();
}
async function prepareOrderDispatch(orderId,itemId,attempt) {
    const actorUid=currentUser?.uid,actorRole=currentUserRole;
    const assertActor=()=>{
        if(!actorUid||currentUser?.uid!==actorUid||currentUserRole!==actorRole
            ||!['admin','purchaser'].includes(actorRole))throw new Error('登入帳號或角色已變更，請以原身分確認打單結果。');
    };
    assertActor();
    if(!attempt||!/^dispatch-ui-[a-zA-Z0-9_-]{12,80}$/.test(attempt.operationId||'')
        ||attempt.orderId!==orderId||attempt.itemId!==itemId||attempt.actorUid!==actorUid||attempt.actorRole!==actorRole
        ||!Number.isFinite(attempt.quantity)||attempt.quantity<=0
        ||!Number.isFinite(attempt.expectedPreparedQty)||attempt.expectedPreparedQty<0)
        throw new Error('打單作業資料不正確，請以原身分重新核對。');
    const intent={...attempt};
    if(dispatchBackendPilotEnabled())
        return prepareV2OrderDispatchBackend(orderId,itemId,intent,assertActor);
    if(intent.syncAttemptId!==undefined||globalThis.YUSHIN_PREVIEW_DISPATCH===true
        ||(typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='preview'))
        throw new Error('原後端打單作業不可改用一般交易重送。');
    let saved;
    await runRoleTransaction(async tx=>{
        assertActor();
        const ref=db.collection('orders').doc(orderId);
        const dispatchRef=db.collection('dispatchRecords').doc(intent.operationId);
        const snap=await tx.get(ref),prior=await tx.get(dispatchRef);
        assertActor();
        if(!snap.exists)throw new Error('找不到訂單。');
        const order=snap.data();
        if(prior.exists){
            const record=prior.data();
            if(record.orderId!==orderId||record.itemId!==itemId||record.preparedByUid!==actorUid
                ||record.actorRole!==actorRole||record.qty!==intent.quantity
                ||record.expectedPreparedQty!==intent.expectedPreparedQty||record.operationId!==intent.operationId)
                throw new Error('打單操作識別碼已用於其他作業。');
            saved=order;return;
        }
        if(normalizedOrderStatus(order)!=='normal')throw new Error('已取消訂單不能打單。');
        const tradeValidation=globalThis.YushinOrderEntry.validateTrade(order);
        if(!tradeValidation.valid)throw new Error(tradeValidation.message);
        const items=normalizedOrderItems(order),index=items.findIndex(item=>item.itemId===itemId);
        if(index<0)throw new Error('找不到訂單品項。');
        const item=items[index];
        if((item.fulfillmentType||'WAREHOUSE')!=='WAREHOUSE'
            ||String(item.productType||item.type||'').toUpperCase()==='SERVICE')
            throw new Error('此品項不屬於實體倉庫打單。');
        // Do not route the Emulator-only multi-location contract through scalar UI.
        // The existing stock wrapper rejects ALL unsupported location markers on read.
        await tx.get(db.collection('inventoryReservations').doc(orderId+'__'+itemId));
        assertActor();
        const state=itemDispatchState(order,item);
        if(state.prepared!==intent.expectedPreparedQty||state.pending<intent.quantity){
            const error=new Error('待打單資料已變更，請更新訂單後重新確認數量。');
            error.code='dispatch-stale';throw error;
        }
        const now=new Date().toISOString(),actor=deliveryActor();
        items[index]={...item,dispatchPreparedQty:state.prepared+intent.quantity};
        tx.set(dispatchRef,{
            orderId,itemId,qty:intent.quantity,operationId:intent.operationId,
            expectedPreparedQty:intent.expectedPreparedQty,actorRole,
            ownerUid:order.ownerUid||'',salesCode:order.salesCode||'',
            customerName:order.customerName||'',itemCode:item.itemCode||'',itemName:item.itemName||'',
            preparedByUid:actorUid,preparedBy:actor,createdAt:now
        });
        const nextOrder={...order,items,updatedAt:now};
        assertActor();
        tx.update(ref,{items,...orderWorkIndexFields(nextOrder),updatedAt:now});
        saved=nextOrder;
    });
    assertActor();
    return saved;
}
