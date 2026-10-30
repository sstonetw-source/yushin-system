// Explicit-source return receipt transport. UI enablement is a separate acceptance gate.
function customerReturnBackendEnabled(){
    return globalThis.YUSHIN_V2_RETURN_RECEIPT_EMULATOR===true
        ||(typeof APP_ENVIRONMENT!=='undefined'&&APP_ENVIRONMENT==='preview'
            &&globalThis.YUSHIN_PREVIEW_CUSTOMER_RETURN===true);
}
function v2CustomerReturnTransport(){
    const local=host=>host==='localhost'||host==='127.0.0.1';
    const emulator=globalThis.YUSHIN_V2_RETURN_RECEIPT_EMULATOR===true;
    const project=emulator?'demo-yushin':'preview-20135';
    const host=String(globalThis.location?.hostname||'').toLowerCase();
    if(!customerReturnBackendEnabled()||typeof firebase==='undefined'||!firebase.auth||!firebase.functions
        ||(emulator?!local(host):!['preview-20135.web.app','preview-20135.firebaseapp.com'].includes(host)))
        throw Error('退貨後端尚未在此環境獲准啟用，禁止改用舊交易。');
    const auth=firebase.auth(),functions=firebase.app().functions('asia-east1');
    const uid=currentUser?.uid,role=currentUserRole;
    const check=()=>{
        if(!customerReturnBackendEnabled()||emulator!==(globalThis.YUSHIN_V2_RETURN_RECEIPT_EMULATOR===true)
            ||firebase.app().options?.projectId!==project||auth.app?.options?.projectId!==project
            ||functions.app?.options?.projectId!==project||db.app?.options?.projectId!==project
            ||(emulator?(!local(auth.emulatorConfig?.host)||auth.emulatorConfig?.port!==9099):!!auth.emulatorConfig))
            throw Error('退貨 Auth、Functions 與資料庫專案或啟用設定已變更，請保留原操作。');
        if(!uid||auth.currentUser?.uid!==uid||currentUser?.uid!==uid||currentUserRole!==role
            ||!['admin','purchaser','warehouse'].includes(role)||!canReceiveInventoryCapability())
            throw Error('登入身分或退貨收貨權限已變更，請使用原帳號與角色確認。');
    };
    check();return {uid,role,functions,check,emulator,project};
}
function v2CustomerReturnPendingKey(uid,orderId){
    return 'v2-return-receipt:'+encodeURIComponent(uid)+':'+encodeURIComponent(orderId);
}
function normalizeV2CustomerReturnReceipt(input){
    const intent=globalThis.YushinFulfillment.normalizeLocationReturnIntent(input);
    if(!intent.requestId||intent.settlement!=='CLOSE')throw Error('退貨實收必須連結原申請並結案，不自動補送。');
    return intent;
}
function pendingV2CustomerReturnReceipt(orderId){
    const raw=sessionStorage.getItem(v2CustomerReturnPendingKey(currentUser?.uid||'',orderId));
    if(!raw)return null;
    try{
        const saved=JSON.parse(raw),intent=normalizeV2CustomerReturnReceipt(saved.intent);
        if(saved.actorUid!==currentUser?.uid||saved.actorRole!==currentUserRole||intent.orderId!==orderId
            ||JSON.stringify(saved.intent)!==JSON.stringify(intent))throw Error('invalid pending receipt');
        return {...saved,intent};
    }catch(_){throw Error('前次退貨收貨結果尚未確認，請保留暫存並使用原帳號與角色核對。');}
}
// This function never writes Firestore. The only writer is commitLocationReturn.
// Calling without input explicitly resumes the saved immutable intent.
async function receiveV2CustomerReturnEmulator(orderId,input){
    const {uid,role,functions,check,emulator,project}=v2CustomerReturnTransport();
    const key=v2CustomerReturnPendingKey(uid,orderId);
    let saved=pendingV2CustomerReturnReceipt(orderId);
    const proposed=input===undefined?null:normalizeV2CustomerReturnReceipt(input);
    if(proposed&&proposed.orderId!==orderId)throw Error('退貨來源訂單不一致。');
    if(saved){
        if((saved.backendProject||'demo-yushin')!==project)throw Error('前次退貨屬於其他專案，請回原環境核對。');
        if(proposed&&JSON.stringify(proposed)!==JSON.stringify(saved.intent))
            throw Error('尚有未確認的退貨收貨，請使用原申請、出貨批次、數量、日期及操作編號確認。');
    }else{
        if(!proposed)throw Error('沒有待確認的退貨收貨。');
        const source=await db.collection('orders').doc(orderId).get({source:'server'});check();
        if(!source.exists)throw Error('找不到原始訂單。');
        const order=source.data(),request=(order.returnRequests||[]).find(r=>r.id===proposed.requestId);
        const concurrent=pendingV2CustomerReturnReceipt(orderId);
        if(concurrent&&JSON.stringify(concurrent.intent)!==JSON.stringify(proposed))
            throw Error('尚有未確認的退貨收貨，請先確認原操作。');
        if(!concurrent&&(order.inventoryReservationStatus!=='completed'||order.inventoryReservationAttemptId!==proposed.syncAttemptId
            ||!request||request.status!=='PENDING'||request.itemId!==proposed.itemId
            ||!(order.warehouseShipmentRecords||[]).some(r=>r.id===proposed.shipmentId
                &&r.itemId===proposed.itemId&&r.warehouseId===proposed.warehouseId)))
            throw Error('請重新確認原待收申請、實際出貨及原倉庫來源。');
        if(concurrent&&(concurrent.backendProject||'demo-yushin')!==project)throw Error('前次退貨屬於其他專案，請回原環境核對。');
        saved=concurrent||{actorUid:uid,actorRole:role,backendProject:project,intent:proposed};
        const raw=JSON.stringify(saved);sessionStorage.setItem(key,raw);
        if(sessionStorage.getItem(key)!==raw)throw Error('無法保存退貨收貨意圖，尚未送出。');
    }
    check();if(emulator)functions.useEmulator('127.0.0.1',5001);
    const intent=saved.intent,response=await functions.httpsCallable('receiveV2CustomerReturn')(intent);check();
    const result=response?.data;
    if(!['applied','already-applied'].includes(result?.status)||result.orderId!==orderId
        ||result.itemId!==intent.itemId||result.shipmentId!==intent.shipmentId||result.warehouseId!==intent.warehouseId
        ||result.requestId!==intent.requestId||result.receiptId!==intent.operationId
        ||result.movementId!=='location-return-'+intent.operationId||result.settlement!=='CLOSE')
        throw Error('退貨收貨回覆無法核對，請保留原操作確認。');
    const receipt=await db.collection('customerReturnReceipts').doc(intent.operationId).get({source:'server'});check();
    const source=await db.collection('orders').doc(orderId).get({source:'server'});check();
    const proof=receipt.exists?receipt.data():null,order=source.exists?source.data():null,record=proof?.record;
    const qty=intent.selections.reduce((total,row)=>total+row.qty,0);
    const selections=record?.lotAllocations?.map(r=>({lotId:r.lotId,qty:r.qty})).sort((a,b)=>a.lotId.localeCompare(b.lotId));
    if(!proof||!order||result.qty!==qty||proof.orderId!==orderId||proof.requestId!==intent.requestId
        ||proof.itemId!==intent.itemId||proof.warehouseId!==intent.warehouseId||proof.qty!==qty
        ||proof.receivedBy!==uid||proof.receivedByRole!==role||proof.quality!=='SALEABLE'||proof.disposition!=='STOCK'
        ||proof.movementId!==result.movementId||!proof.intentHash||proof.intentHash!==record?.intentHash
        ||record?.id!==intent.operationId||record.orderId!==orderId||record.itemId!==intent.itemId
        ||record.shipmentId!==intent.shipmentId||record.requestId!==intent.requestId||record.warehouseId!==intent.warehouseId
        ||record.qty!==qty||record.date!==intent.date||record.reason!==intent.reason
        ||record.condition!==intent.condition||record.settlement!=='CLOSE'
        ||record.createdByUid!==uid||record.createdByRole!==role||record.movementId!==result.movementId
        ||JSON.stringify(selections)!==JSON.stringify(intent.selections)
        ||!(order.returnRequests||[]).some(r=>r.id===intent.requestId&&r.itemId===intent.itemId&&r.receivedQty>=qty)
        ||!(order.returnRecords||[]).some(r=>r.id===intent.operationId&&v2CustomerReturnProofEqual(r,record)))
        throw Error('退貨收貨已回覆，但原申請或實收憑證尚未核對，請以原操作再次確認。');
    // Do not erase a checkpoint replaced by another operation while awaiting reads.
    const remaining=sessionStorage.getItem(key);
    if(remaining!==null&&remaining!==JSON.stringify(saved))throw Error('退貨待確認資料已變更，請重新核對。');
    sessionStorage.removeItem(key);
    return {...order,id:orderId};
}
function v2CustomerReturnProofEqual(left,right){
    if(left===right)return true;
    if(!left||!right||typeof left!=='object'||typeof right!=='object'||Array.isArray(left)!==Array.isArray(right))return false;
    const a=Object.keys(left).sort(),b=Object.keys(right).sort();
    return JSON.stringify(a)===JSON.stringify(b)&&a.every(key=>v2CustomerReturnProofEqual(left[key],right[key]));
}
