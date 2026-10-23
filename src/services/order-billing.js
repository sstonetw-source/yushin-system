// Shared order billing service. UI is responsible for feedback, not Firestore writes.
async function setOrderBillingStatus(orderId,newValue,billingDate,logEntry,timestamp) {
    if(typeof newValue!=='boolean')throw new Error('核銷狀態必須明確指定。');
    if(newValue&&!isValidOrderBillingDate(billingDate))throw new Error('請選擇正確的核銷日期。');
    return runRoleTransaction(async transaction=>{
        const ref=db.collection('orders').doc(orderId);
        const snapshot=await transaction.get(ref);
        if(!snapshot.exists)throw new Error('找不到這筆訂單。');
        const order=snapshot.data();
        if((order.items||[]).some(item=>String(item?.productType||'').trim().toUpperCase()==='SERVICE'))
            throw new Error('服務訂單須由後端核對完工憑證後核銷；目前原核銷入口尚未開放。');
        if(normalizedOrderStatus(order)!=='normal')throw new Error('這筆訂單已取消。');
        if(!!order.isBilled===newValue)return {
            isBilled:newValue,billingDate:order.billingDate||'',
            status:order.status||BUSINESS_STATUS.ACTIVE,
            statusHistory:[...(order.statusHistory||[])]
        };
        const updates={
            isBilled:newValue,
            billingDate:newValue?billingDate:'',
            status:BUSINESS_STATUS.ACTIVE,updatedAt:timestamp,
            statusHistory:firebase.firestore.FieldValue.arrayUnion(logEntry)
        };
        Object.assign(updates,orderWorkIndexFields({...order,...updates}));
        transaction.update(ref,updates);
        return {isBilled:newValue,billingDate:updates.billingDate,
            status:BUSINESS_STATUS.ACTIVE,
            statusHistory:[...(order.statusHistory||[]),logEntry]};
    });
}

function isValidOrderBillingDate(value) {
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
    const [year,month,day]=value.split('-').map(Number);
    const date=new Date(Date.UTC(year,month-1,day));
    return date.getUTCFullYear()===year&&date.getUTCMonth()===month-1&&date.getUTCDate()===day;
}

async function changeOrderBillingDate(orderId,value,history) {
    if(!isValidOrderBillingDate(value))throw new Error('請選擇正確的核銷日期。');
    return runRoleTransaction(async transaction=>{
        const ref=db.collection('orders').doc(orderId);
        const snapshot=await transaction.get(ref);
        if(!snapshot.exists)throw new Error('找不到這筆訂單。');
        const order=snapshot.data();
        if((order.items||[]).some(item=>String(item?.productType||'').trim().toUpperCase()==='SERVICE'))
            throw new Error('服務核銷日期須由後端修改；目前日期修改尚未開放。');
        if(normalizedOrderStatus(order)!=='normal'||order.isBilled!==true)
            throw new Error('這筆訂單已取消或尚未核銷，不能更改核銷日期。');
        if(String(order.billingDate||'')===value)return {
            billingDate:value,fieldEditHistory:[...(order.fieldEditHistory||[])]};
        const entry={...history,before:String(order.billingDate||history.before||'')};
        transaction.update(ref,{
            billingDate:value,updatedAt:entry.at,
            fieldEditHistory:firebase.firestore.FieldValue.arrayUnion(entry)
        });
        return {billingDate:value,fieldEditHistory:[...(order.fieldEditHistory||[]),entry]};
    });
}


// Callable adapter only. Financial decisions remain in commitServiceOrderBilling.
function serviceBillingPendingKey(uid){return 'service-billing-pending:'+encodeURIComponent(uid);}
function normalizeServiceBillingIntent(input){
    if(!input||Object.keys(input).some(k=>!['orderId','operationId','isBilled','billingDate','expectedIsBilled'].includes(k))
        ||typeof input.orderId!=='string'||!input.orderId||input.orderId!==input.orderId.trim()
        ||input.orderId.includes('/')||input.orderId.length>160
        ||typeof input.operationId!=='string'||!/^[a-zA-Z0-9_-]{12,96}$/.test(input.operationId)
        ||typeof input.isBilled!=='boolean'||typeof input.expectedIsBilled!=='boolean'
        ||(input.isBilled?!isValidOrderBillingDate(input.billingDate):input.billingDate!==''))
        throw Error('服務核銷操作資料不正確。');
    return {orderId:input.orderId,operationId:input.operationId,isBilled:input.isBilled,
        billingDate:input.billingDate,expectedIsBilled:input.expectedIsBilled};
}
function pendingServiceBillingIntent(){
    const raw=sessionStorage.getItem(serviceBillingPendingKey(currentUser?.uid||''));
    if(!raw)return null;
    try{
        const saved=JSON.parse(raw),intent=normalizeServiceBillingIntent(saved.intent);
        if(saved.uid!==currentUser.uid||saved.role!==currentUserRole
            ||JSON.stringify(intent)!==JSON.stringify(saved.intent))throw Error('mismatch');
        return {...saved,intent};
    }catch(_){throw Error('前次服務核銷暫存無法核對，請保留原分頁與帳號確認。');}
}
async function commitServiceBillingIntent(input){
    const t=serviceCaseTransport(),key=serviceBillingPendingKey(t.uid);
    if(!['admin','sales','engineer'].includes(t.role))throw Error('目前沒有服務核銷權限。');
    let saved=pendingServiceBillingIntent();
    const intent=input===undefined?saved?.intent:normalizeServiceBillingIntent(input);
    if(!intent)throw Error('沒有待確認的服務核銷操作。');
    if(saved&&JSON.stringify(saved.intent)!==JSON.stringify(intent))throw Error('請先確認前次服務核銷結果。');
    if(!saved){
        saved={uid:t.uid,role:t.role,intent};const raw=JSON.stringify(saved);
        sessionStorage.setItem(key,raw);
        if(sessionStorage.getItem(key)!==raw)throw Error('無法保存原核銷操作，尚未送出。');
    }
    const raw=JSON.stringify(saved);
    let reply;
    try{reply=await t.call('commitServiceOrderBilling',intent);}
    catch(error){
        t.check();
        // Only a definitive server refusal can release an unacknowledged intent.
        // Network/timeout/internal failures keep the original operation for retry.
        if(['functions/invalid-argument','functions/failed-precondition','functions/permission-denied',
            'functions/not-found','functions/already-exists'].includes(error.code)
            &&sessionStorage.getItem(key)===raw)sessionStorage.removeItem(key);
        throw error;
    }
    if(!['committed','already-applied'].includes(reply?.status)||reply.orderId!==intent.orderId
        ||reply.operationId!==intent.operationId||reply.isBilled!==intent.isBilled
        ||(intent.isBilled&&reply.billingDate!==intent.billingDate))
        throw Error('核銷回覆無法核對，請保留原操作重試。');
    // A replay receipt is historical: read the current order rather than applying
    // its old result over a later reversal or date change by another operator.
    const snap=await db.collection('orders').doc(intent.orderId).get({source:'server'});
    t.check();
    if(!snap.exists)throw Error('核銷已回覆，但目前訂單尚未讀取成功，請以原操作重試。');
    const order=snap.data();
    if(order.isBilled!==undefined&&typeof order.isBilled!=='boolean')throw Error('目前核銷狀態無法核對。');
    if(sessionStorage.getItem(key)!==raw)throw Error('待確認核銷操作已變更，請保留暫存核對。');
    sessionStorage.removeItem(key);
    return {receipt:reply,order:{...order,id:intent.orderId}};
}
