// V2 capabilities: role names are mapped once here instead of scattering role === 'sales'
// checks throughout commercial workflows. Firestore Rules mirror these boundaries.
let permissionRulesReady = false;
let permissionRulesCheckedUid = '';
let permissionRulesCheckPromise = null;
function ensurePermissionRulesReady() {
    const uid=currentUser?.uid||'';
    const generation=sessionDataGeneration;
    const isCurrent=()=>generation===sessionDataGeneration&&uid===currentUser?.uid;
    if(!uid)return Promise.resolve(false);
    if(permissionRulesCheckedUid===uid)return Promise.resolve(permissionRulesReady);
    if(permissionRulesCheckPromise)return permissionRulesCheckPromise;
    permissionRulesCheckPromise=firestoreReadWithTimeout(db.collection('stockOperations').doc('permissions-probe').get(),'權限規則版本')
        .then(()=>{if(!isCurrent())return false;permissionRulesReady=true;return true;})
        .catch(err=>{if(!isCurrent())return false;permissionRulesReady=false;console.warn('權限規則版本尚未確認；交易仍使用共用安全流程，不回退舊寫入方式。',err.code||err.message);return false;})
        .finally(()=>{if(!isCurrent())return;permissionRulesCheckedUid=uid;permissionRulesCheckPromise=null;applyPermissionVisibility();});
    return permissionRulesCheckPromise;
}
function supplyOrdersCollection() {
    return db.collection(currentUserRole === 'warehouse' && permissionRulesReady ? 'receivingSupplyOrders' : 'supplyOrders');
}
async function runRoleTransaction(callback) {
    const actorUid=currentUser?.uid||'',actorRole=currentUserRole;
    const assertSession=()=>{if(!actorUid||currentUser?.uid!==actorUid||currentUserRole!==actorRole)throw new Error('登入帳號或角色已變更，請重新開啟作業。');};
    await ensurePermissionRulesReady();
    assertSession();
    if(!globalThis.YushinStockPermissions?.run)throw new Error('安全交易模組未載入，請重新整理後再試。');
    const result = await globalThis.YushinStockPermissions.run(db, callback, actorUid,
        actorRole === 'sales' || actorRole === 'engineer', actorRole, assertSession);
    // A successful transaction can change orders, receipts, stock or purchasing.
    // The next analysis visit must read fresh sources instead of reusing the old report.
    tradeAnalysisReady = false;
    tradeAnalysisLoadedKey = '';
    if(typeof tradeAnalysisSnapshots!=='undefined')tradeAnalysisSnapshots.clear();
    if(typeof tradeAnalysisRevision!=='undefined')tradeAnalysisRevision++;
    markMainPageDirty('admin');
    return result;
}

