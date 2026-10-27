// Transport only. All receipt quantities and writes remain in the same receiving Service.
async function receiveV2SupplyEmulator(supplyId,qty,lotNo,expiryDate,operationId,options) {
    const local=host=>['localhost','127.0.0.1'].includes(host);
    const emulator=typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='emulator'
        &&globalThis.YUSHIN_V2_RECEIVING_EMULATOR===true;
    const preview=typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='preview'
        &&globalThis.YUSHIN_PREVIEW_RECEIVING===true;
    const host=String(globalThis.location?.hostname||'').toLowerCase();
    if((!emulator&&!preview)||typeof firebase==='undefined'||!firebase.functions
        ||(emulator&&!local(host))
        ||(preview&&!['preview-20135.web.app','preview-20135.firebaseapp.com'].includes(host)))
        throw Error('收貨後端尚未在目前授權的測試環境啟用，禁止改用舊交易。');
    const auth=firebase.auth(),functions=firebase.app().functions('asia-east1');
    const project=emulator?'demo-yushin':'preview-20135';
    if(auth.app?.options?.projectId!==project||functions.app?.options?.projectId!==project
        ||firebase.app().options?.projectId!==project
        ||(emulator&&(!local(auth.emulatorConfig?.host)||auth.emulatorConfig?.port!==9099))
        ||(preview&&!!auth.emulatorConfig))
        throw Error('收貨 Auth、Functions 與資料庫專案不一致，未提交收貨。');
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
    if(emulator)functions.useEmulator('127.0.0.1',5001);
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
