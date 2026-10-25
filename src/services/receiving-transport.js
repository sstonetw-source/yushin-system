// Transport only. All receipt quantities and writes remain in the same receiving Service.
async function receiveV2SupplyEmulator(supplyId,qty,lotNo,expiryDate,operationId,options) {
    const local=host=>['localhost','127.0.0.1'].includes(host);
    if(typeof APP_ENVIRONMENT==='undefined'||APP_ENVIRONMENT!=='emulator'
        ||!local(globalThis.location?.hostname)||typeof firebase==='undefined'||!firebase.functions)
        throw Error('多倉收貨後端僅限本機 Emulator。');
    const auth=firebase.auth(),functions=firebase.app().functions('asia-east1');
    if(auth.app?.options?.projectId!=='demo-yushin'||functions.app?.options?.projectId!=='demo-yushin'
        ||!local(auth.emulatorConfig?.host)||auth.emulatorConfig?.port!==9099)
        throw Error('多倉收貨必須使用 demo-yushin 本機登入與 Functions。');
    const uid=options.actorUid??currentUser?.uid,role=options.actorRole??currentUserRole;
    const check=()=>{
        if(!uid||auth.currentUser?.uid!==uid||currentUser?.uid!==uid||currentUserRole!==role
            ||!(['admin','purchaser','warehouse'].includes(role)&&canReceiveInventoryCapability()
                 ||['sales','engineer'].includes(role)))
            throw Error('收貨身分已變更，請以原帳號核對。');
    };
    check();
    const jobs=JSON.parse(sessionStorage.getItem('yushin-receipt-tasks:'+uid)||'[]');
    const job=Array.isArray(jobs)&&jobs.find(job=>job.ownerUid===uid&&job.actorRole===role&&job.supplyId===supplyId
        &&job.entries?.some(entry=>`${job.operationBase}-${entry.itemIndex}`===operationId&&entry.qty===qty&&entry.lotNo===lotNo&&entry.expiryDate===expiryDate));
    if(!job)throw Error('收貨原始作業尚未安全保存，請保留原資料並重新確認。');
    functions.useEmulator('127.0.0.1',5001);
    const response=await functions.httpsCallable('receiveV2Supply')({supplyId,qty,lotNo,expiryDate,operationId});check();
    const result=response?.data;
    if(result?.status!=='confirmed'||result.supplyId!==supplyId||result.operationId!==operationId
        ||!Array.isArray(result.affectedOrderIds)||result.affectedOrderIds.some(id=>typeof id!=='string'||!id))
        throw Error('收貨回覆不明確，請使用原資料重試。');
    const receipt=await db.collection('receipts').doc(operationId).get({source:'server'});check();
    const proof=receipt.exists?receipt.data():null;
    // Direct receipts deliberately omit warehouse lot/expiry fields. Match that
    // schema without weakening exact batch checks for physical warehouse receipts.
    const direct=proof?.fulfillmentType==='DIRECT_SHIP';
    const empty=value=>value===undefined||value==='';
    const batchMatches=direct
        ? lotNo===''&&expiryDate===''&&empty(proof.lotNo)&&empty(proof.expiryDate)&&proof.warehouseId===''
        : proof?.lotNo===lotNo&&proof?.expiryDate===expiryDate;
    if(!proof||proof.supplyOrderId!==supplyId||proof.qty!==qty||!batchMatches
        ||proof.createdByUid!==uid||proof.createdByRole!==role
        ||(!direct&&proof.reservationLocationSchemaVersion!==2))
        throw Error('收貨已可能提交，但憑證尚未確認，請使用原資料重試。');
    if(proof.fulfillmentType!=='DIRECT_SHIP')
        options.onStockCommitted?.(proof.productKey,proof.warehouseId);
    check();return result.affectedOrderIds;
}
