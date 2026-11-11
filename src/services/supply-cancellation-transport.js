// #536: supplier cancellation uses one Admin SDK operation, never a browser stock writer.
// Keep the original operation ID until both the Callable receipt and live source are verified.
function supplyCancellationPendingKey(poId,supplyId,whole){
    return 'supply-cancel:'+encodeURIComponent(currentUser?.uid||'')+':'+
        encodeURIComponent(whole?'PO:'+poId:'SUPPLY:'+poId+':'+supplyId);
}
function pendingSupplyCancellation(poId,supplyId,whole){
    const raw=sessionStorage.getItem(supplyCancellationPendingKey(poId,supplyId,whole));
    if(raw===null)return null;
    try{
        const p=JSON.parse(raw),input=p?.payload;
        if(p.uid!==currentUser?.uid||p.role!==currentUserRole||p.project!=='yu-shing-company'
            ||p.whole!==whole||input?.poId!==poId||input?.supplyId!==(whole?undefined:supplyId)
            ||typeof input.reason!=='string'||!input.reason.trim()||input.reason!==input.reason.trim()
            ||input.reason.length>500||/[\x00-\x1f]/.test(input.reason)
            ||!/^[a-zA-Z0-9_-]{12,96}$/.test(input.operationId)
            ||Object.keys(input).sort().join(',')!==(whole?'operationId,poId,reason':'operationId,poId,reason,supplyId'))
            throw Error('invalid');
        return p;
    }catch(_){throw Error('原供應商取消操作的暫存內容不一致，請保留紀錄並核對，勿建立新操作。');}
}
async function commitSupplyCancellationBackend(poId,supplyId,reason,whole,
    {actorUid,actorRole,onStockCommitted,onDemandChanged}){
    if(typeof productionTransactionBackendEnabled!=='function'
        ||!productionTransactionBackendEnabled('SUPPLY_CANCELLATION')
        ||typeof firebase==='undefined'||!firebase.auth||!firebase.functions||!firebase.app)
        throw Error('供應商取消後端未核准或環境不完整，禁止回退瀏覽器寫入。');
    const app=firebase.app(),auth=firebase.auth(),functions=app.functions('asia-east1'),project='yu-shing-company';
    const check=()=>{
        if(!productionTransactionBackendEnabled('SUPPLY_CANCELLATION')
            ||app.options?.projectId!==project||auth.app?.options?.projectId!==project
            ||functions.app?.options?.projectId!==project||db?.app?.options?.projectId!==project
            ||!!auth.emulatorConfig||!actorUid||auth.currentUser?.uid!==actorUid
            ||currentUser?.uid!==actorUid||currentUserRole!==actorRole
            ||!['admin','purchaser'].includes(actorRole)||!canCreatePurchaseOrderCapability()
            ||!canAccessPage('orders.po'))
            throw Error('供應商取消的登入身份、專案或授權已變更，請使用原操作 ID 核對。');
    };
    check();
    if(typeof poId!=='string'||!poId||poId.includes('/')||poId!==poId.trim()||poId.length>160
        ||(!whole&&(typeof supplyId!=='string'||!supplyId||supplyId.includes('/')||supplyId!==supplyId.trim()
            ||supplyId.length>160)))
        throw Error('原採購單或供應識別碼不正確。');
    const key=supplyCancellationPendingKey(poId,supplyId,whole);
    let saved=pendingSupplyCancellation(poId,supplyId,whole);
    if(saved){
        if(reason&&reason.trim()!==saved.payload.reason)
            throw Error('上次取消操作尚未確認，請保留原取消原因與操作 ID 續傳。');
    }else{
        if(typeof reason!=='string'||!reason.trim()||reason!==reason.trim()||reason.length>500
            ||/[\x00-\x1f]/.test(reason))
            throw Error('請輸入有效的供應商取消原因。');
        const operationId=lifecycleRecordId();
        if(!/^[a-zA-Z0-9_-]{12,96}$/.test(operationId))throw Error('無法建立安全操作 ID。');
        const payload={operationId,poId,reason,...(whole?{}:{supplyId})};
        saved={uid:actorUid,role:actorRole,project,whole,payload};
        const raw=JSON.stringify(saved);sessionStorage.setItem(key,raw);
        if(sessionStorage.getItem(key)!==raw)throw Error('無法保存原取消操作，尚未提交。');
    }
    check();
    const callable=whole?'stopV2PurchaseOrderOutstanding':'cancelV2OutstandingSupply';
    const response=await functions.httpsCallable(callable)(saved.payload);check();
    const r=response?.data;
    if(!['applied','already-applied'].includes(r?.status)||r.operationId!==saved.payload.operationId
        ||r.poId!==poId||r.actorUid!==actorUid||r.actorRole!==actorRole
        ||!Array.isArray(r.supplyIds)||!r.supplyIds.length||new Set(r.supplyIds).size!==r.supplyIds.length
        ||(!whole&&(r.supplyIds.length!==1||r.supplyIds[0]!==supplyId))
        ||!Number.isSafeInteger(r.cancelledQty)||r.cancelledQty<0
        ||!Array.isArray(r.affectedOrderIds))
        throw Error('取消結果無法核對，請保留原操作 ID，禁止重新開立。');
    const supplies=[];
    let previouslyStoppedQty=0;
    for(const id of r.supplyIds){
        const snap=await db.collection('supplyOrders').doc(id).get({source:'server'});check();
        const supply=snap.exists?snap.data():null;
        if(!supply||(supply.purchaseDocumentId||supply.internalNo||id)!==poId)
            throw Error('取消回覆缺少原供應來源，請保留操作 ID。');
        if(supply.cancellationOperationId===saved.payload.operationId){
            if(!['CLOSED','CANCELLED'].includes(supply.status)||supply.incomingRegisteredQty!==0)
                throw Error('已取消來源與在途餘額不一致，請保留操作 ID。');
        }else if(whole&&['CLOSED','CANCELLED'].includes(supply.status)
            &&supply.incomingRegisteredQty===0
            &&/^[a-zA-Z0-9_-]{12,96}$/.test(supply.cancellationOperationId||'')
            &&Number.isSafeInteger(supply.qty)&&Number.isSafeInteger(supply.receivedQty)
            &&supply.qty>supply.receivedQty&&supply.receivedQty>=0
            &&(supply.status==='CLOSED'?supply.closedQty:supply.cancelledQty)===supply.qty-supply.receivedQty){
            previouslyStoppedQty+=supply.qty-supply.receivedQty;
            if(!Number.isSafeInteger(previouslyStoppedQty))
                throw Error('整張採購單先前停止數量超出範圍，請保留操作 ID。');
        }else if(supply.qty!==supply.receivedQty)
            throw Error('原供應未全部收貨且未具有取消憑證，請保留操作 ID。');
        supplies.push({id,...supply});
    }
    const changed=supplies.filter(s=>s.cancellationOperationId===saved.payload.operationId);
    if(changed.reduce((sum,s)=>sum+s.qty-s.receivedQty,0)!==r.cancelledQty)
        throw Error('取消量與來源供應憑證不一致，請保留原操作 ID。');
    let patch=null;
    if(whole){
        const snap=await db.collection('purchaseOrders').doc(poId).get({source:'server'});check();
        const po=snap.exists?snap.data():null;
        if(!po||po.poNo!==poId||JSON.stringify(po.supplyOrderIds)!==JSON.stringify(r.supplyIds))
            throw Error('整張採購單供應連結與回覆不符，請保留原操作 ID。');
        if(r.cancelledQty+previouslyStoppedQty){
            if(po.cancellationOperationId!==saved.payload.operationId||!['CLOSED','CANCELLED'].includes(po.status)
                ||po.stoppedQty!==r.cancelledQty+previouslyStoppedQty)
                throw Error('採購單停止狀態尚未核對，請保留原操作 ID。');
            patch={status:po.status,stoppedQty:po.stoppedQty,updatedAt:po.updatedAt,
                ...(po.status==='CLOSED'?{closedQty:po.closedQty,closedAt:po.closedAt}:{cancelledQty:po.cancelledQty,cancelledAt:po.cancelledAt})};
        }
    }
    if(sessionStorage.getItem(key)!==JSON.stringify(saved))
        throw Error('原操作暫存已遭變更，請保留原操作 ID。');
    sessionStorage.removeItem(key);
    const result=whole?{patch,cancelledQty:r.cancelledQty,supplyIds:r.supplyIds,affectedOrderIds:r.affectedOrderIds}
        :{cancelledQty:r.cancelledQty,terminalStatus:supplies[0].status,orderId:supplies[0].orderId||'',
            productKey:supplies[0].productKey||'',warehouseId:supplies[0].warehouseId||'',demandId:supplies[0].demandId||''};
    try{
        for(const supply of changed){
            if(supply.fulfillmentType==='WAREHOUSE')onStockCommitted?.(supply.productKey,supply.warehouseId);
            if(supply.demandId)onDemandChanged?.(supply.demandId);
        }
    }catch(error){error.supplyCommitted=true;error.supplyResult=result;throw error;}
    return result;
}
