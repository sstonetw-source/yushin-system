// Authenticated whole-order reservation bridge. Both Preview and production
// require explicit gates; no browser-side fallback may write initial stock.

let orderReservationFunctionsScriptPromise = null;

function orderReservationBackendPreviewEnabled() {
    return APP_ENVIRONMENT === 'preview'
        && globalThis.YUSHIN_PREVIEW_ORDER_RESERVATION_BACKEND === true;
}
// Production remains independently default-closed. The server checks the
// project and a separate production gate before accepting any transaction.

function orderReservationBackendEnabled() {
    return orderReservationBackendPreviewEnabled()
        || (APP_ENVIRONMENT === 'emulator'
            && globalThis.YUSHIN_ORDER_RESERVATION_EMULATOR === true
            && typeof firebase !== 'undefined'
            && firebase.app().options?.projectId === 'demo-yushin')
        || (APP_ENVIRONMENT === 'production'
            && globalThis.YUSHIN_PRODUCTION_ORDER_RESERVATION_BACKEND === true
            && globalThis.YUSHIN_PRODUCTION_ORDER_RESERVATION_LEGACY_BLOCKED === true
            && typeof firebase !== 'undefined'
            && firebase.app().options?.projectId === 'yu-shing-company');
}

async function ensureReservationFunctionsCompat() {
    if (!firebase.functions) {
        if (!orderReservationFunctionsScriptPromise) {
            orderReservationFunctionsScriptPromise=new Promise((resolve,reject)=>{
                const script=document.createElement('script');
                script.src='https://www.gstatic.com/firebasejs/10.8.0/firebase-functions-compat.js';
                script.onload=resolve;
                script.onerror=()=>reject(new Error('無法載入 Firebase Functions，整單預留未提交。'));
                document.head.appendChild(script);
            }).catch(error=>{orderReservationFunctionsScriptPromise=null;throw error;});
        }
        await orderReservationFunctionsScriptPromise;
    }
    if (!firebase.functions) throw new Error('Firebase Functions 尚未初始化，後端預留未提交。');
}

async function commitNewOrderReservationPreview(orderId,liveOrder,actorUid) {
    if (!orderReservationBackendEnabled()) return false;
    if (!actorUid || currentUser?.uid!==actorUid)
        throw new Error('登入身分已變更，停止後端庫存同步。');
    const syncAttemptId=String(liveOrder.inventoryReservationAttemptId||'');
    if (liveOrder.inventoryReservationStatus!=='pending'
        || !/^[a-zA-Z0-9_-]{12,96}$/.test(syncAttemptId))
        throw new Error('訂單同步識別碼已變更，請重新讀取。');
    // Reuse the Functions compat SDK loader; never run a client-side stock
    // transaction after a failed or ambiguous backend result.
    await ensureReservationFunctionsCompat();
    if (!orderReservationBackendEnabled() || currentUser?.uid!==actorUid)
        throw new Error('登入身分或測試環境已變更，停止後端庫存同步。');
    const callable=firebase.app().functions('asia-east1').httpsCallable('commitOrderReservationPreview');
    const reply=await callable({orderId,syncAttemptId});
    if (!orderReservationBackendEnabled())
        throw new Error('預留後端旗標已關閉，請保留原同步識別碼核對交易結果。');
    if (!['applied','already-applied'].includes(reply?.data?.status)
        || reply.data.receiptId!=='order-sync-'+orderId+'__'+syncAttemptId)
        throw new Error('後端預留回覆不明確或原憑證不符，請以原識別碼核對結果。');
    if (currentUser?.uid!==actorUid)
        throw new Error('後端預留可能已提交，但登入身分已變更，請重新讀取結果。');
    invalidateProcurementDemandQueue();
    return true;
}
