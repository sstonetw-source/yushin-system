// All writes go through the existing server Service; this transport never writes Firestore.
function serviceCaseClientProject(){
    const location=globalThis.location;
    if(globalThis.YUSHIN_SERVICE_CASE_EMULATOR===true&&['localhost','127.0.0.1'].includes(location?.hostname))
        return 'demo-yushin';
    if(globalThis.YUSHIN_PRODUCTION_SERVICE_CASE_BACKEND===true
        &&location?.origin==='https://sstonetw-source.github.io'
        &&(location.pathname==='/yushin-system'||location.pathname?.startsWith('/yushin-system/')))
        return 'yu-shing-company';
    return '';
}
function serviceCaseTransport(){
    const project=serviceCaseClientProject();
    if(!project)throw Error('服務訂單後端尚未在目前環境啟用。');
    const emulator=project==='demo-yushin',auth=firebase.auth();
    const uid=currentUser?.uid,role=currentUserRole;
    const generation=typeof sessionDataGeneration==='undefined'?null:sessionDataGeneration;
    const check=()=>{
        if((typeof sessionDataGeneration==='undefined'?null:sessionDataGeneration)!==generation
            ||!uid||auth.currentUser?.uid!==uid||currentUser?.uid!==uid||currentUserRole!==role
            ||!['admin','sales','purchaser','engineer'].includes(role))throw Error('登入身分或服務作業權限已變更。');
    };
    if(auth.app?.options?.projectId!==project
        ||(emulator&&(!['localhost','127.0.0.1'].includes(auth.emulatorConfig?.host)||auth.emulatorConfig?.port!==9099))
        ||(!emulator&&(auth.emulatorConfig||typeof db==='undefined'||db.app?.options?.projectId!==project)))
        throw Error('服務案件 Auth 與資料庫專案不一致。');
    check();
    return {uid,role,check,call:async(name,input)=>{
        check();
        if(!emulator&&!firebase.functions)await ensureFormalPurchaseFunctionsCompat();
        check();
        const functions=firebase.app().functions('asia-east1');
        if(functions.app?.options?.projectId!==project)throw Error('服務案件 Functions 專案不一致。');
        if(emulator)functions.useEmulator('127.0.0.1',5001);
        const reply=await functions.httpsCallable(name)(input);
        check();
        return reply.data;
    }};
}
