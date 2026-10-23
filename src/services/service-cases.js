// All writes go through the existing server Service; this transport never writes Firestore.
function serviceCaseTransport(){
    const local=h=>['localhost','127.0.0.1'].includes(h);
    if(globalThis.YUSHIN_SERVICE_CASE_EMULATOR!==true||!local(globalThis.location?.hostname))
        throw Error('服務案件目前僅限本機 Emulator。');
    const auth=firebase.auth(),functions=firebase.app().functions('asia-east1');
    const uid=currentUser?.uid,role=currentUserRole;
    const check=()=>{
        if(!uid||auth.currentUser?.uid!==uid||currentUser?.uid!==uid||currentUserRole!==role
            ||!['admin','sales','warehouse','engineer'].includes(role))throw Error('登入身分或服務作業權限已變更。');
    };
    if(auth.app?.options?.projectId!=='demo-yushin'||functions.app?.options?.projectId!=='demo-yushin'
        ||!local(auth.emulatorConfig?.host)||auth.emulatorConfig?.port!==9099)
        throw Error('服務案件只允許本機 demo-yushin Auth／Functions Emulator。');
    check();functions.useEmulator('127.0.0.1',5001);
    return {uid,role,check,call:async(name,input)=>{
        check();const reply=await functions.httpsCallable(name)(input);check();return reply.data;
    }};
}
function serviceCasePendingKey(uid){return 'service-case-pending:'+encodeURIComponent(uid);}
function normalizeServiceCaseIntent(input,uid){
    if(!input||Object.keys(input).some(k=>!['orderId','itemId','caseId','serviceQty','event'].includes(k)))throw Error('服務操作格式不正確。');
    for(const key of ['orderId','itemId','caseId']){
        const value=input[key];
        if(typeof value!=='string'||!value||value!==value.trim()||value.includes('/')||value.length>160)throw Error('服務操作識別碼不正確。');
    }
    const event=YushinServiceWork.normalizedEvent({...input.event,actorUid:uid});
    // Identity is supplied by Firebase Auth, never submitted as an authority field.
    delete event.actorUid;
    return {orderId:input.orderId,itemId:input.itemId,caseId:input.caseId,
        serviceQty:YushinServiceWork.serviceQuantity(input.serviceQty),event};
}
function pendingServiceCaseIntent(){
    const raw=sessionStorage.getItem(serviceCasePendingKey(currentUser?.uid||''));if(!raw)return null;
    try{
        const saved=JSON.parse(raw),intent=normalizeServiceCaseIntent(saved.intent,currentUser.uid);
        if(saved.uid!==currentUser.uid||saved.role!==currentUserRole||JSON.stringify(intent)!==JSON.stringify(saved.intent))throw Error('mismatch');
        return {...saved,intent};
    }catch(_){throw Error('前次服務操作暫存無法核對，請保留原分頁並使用原帳號與角色確認。');}
}
async function readServiceCases(input){
    const transport=serviceCaseTransport();return transport.call('getServiceCaseStatus',input);
}
async function commitServiceCaseIntent(input){
    const t=serviceCaseTransport(),key=serviceCasePendingKey(t.uid);
    let saved=pendingServiceCaseIntent();
    const intent=input===undefined?saved?.intent:normalizeServiceCaseIntent(input,t.uid);
    if(!intent)throw Error('沒有待確認的服務操作。');
    if(saved&&JSON.stringify(saved.intent)!==JSON.stringify(intent))throw Error('請先確認前次服務操作結果。');
    if(!saved){
        saved={uid:t.uid,role:t.role,intent};const raw=JSON.stringify(saved);
        sessionStorage.setItem(key,raw);
        if(sessionStorage.getItem(key)!==raw)throw Error('無法保存原服務操作，尚未送出。');
    }
    t.check();
    const result=await t.call('commitServiceCaseEvent',saved.intent);
    if(!['committed','already-applied'].includes(result?.status)||result.orderId!==intent.orderId
        ||result.itemId!==intent.itemId||result.caseId!==intent.caseId||result.serviceQty!==intent.serviceQty)
        throw Error('服務操作回覆無法核對，請以原資料確認。');
    const proof=await t.call('getServiceCaseStatus',{orderId:intent.orderId,itemId:intent.itemId,caseId:intent.caseId});
    const expected=YushinServiceWork.normalizedEvent({...intent.event,actorUid:t.uid});
    const event=proof?.events?.find(e=>e.id===intent.event.id);
    if(!proof.exists||proof.orderId!==intent.orderId||proof.itemId!==intent.itemId||proof.caseId!==intent.caseId
        ||proof.serviceQty!==intent.serviceQty||!event
        ||Object.keys({...expected,...event}).some(k=>expected[k]!==event[k]))
        throw Error('服務操作已回覆，但事件憑證尚未核對，請保留原操作確認。');
    t.check();
    const current=sessionStorage.getItem(key);
    if(current!==null&&current!==JSON.stringify(saved))throw Error('待確認操作已變更，請保留暫存核對。');
    sessionStorage.removeItem(key);return proof;
}
