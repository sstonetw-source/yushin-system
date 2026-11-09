'use strict';

function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    throw error;
}

// Password and Firestore cannot commit atomically across Firebase Auth/Firestore.
// Auth changes first; on a Firestore failure the requirement stays locked, and the
// user can sign in with the new password and retry. No client may clear this flag.
async function completeRequiredPasswordChange(db, authAdmin, uid, authTime, payload, nowSeconds = Math.floor(Date.now() / 1000)) {
    if (!uid) fail('unauthenticated', '請先登入');
    if (!Number.isSafeInteger(authTime) || authTime > nowSeconds + 30 || nowSeconds - authTime > 300)
        fail('failed-precondition', '為保護帳號，請先登出並重新登入後修改密碼');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
        || typeof payload.newPassword !== 'string' || payload.newPassword.length < 6
        || payload.newPassword.length > 128)
        fail('invalid-argument', '新密碼需為 6 至 128 個字元');
    if (!db || !authAdmin || typeof authAdmin.updateUser !== 'function')
        fail('failed-precondition', '修改密碼後端尚未準備完成');

    const userRef = db.collection('users').doc(uid);
    const before = await userRef.get();
    if (!before.exists || before.data()?.disabled === true || before.data()?.active === false)
        fail('permission-denied', '帳號已停用或不存在');
    if (before.data()?.mustChangePassword !== true)
        // An administrator could have cancelled the requirement. Never claim
        // this request updated the password when it did not.
        return { completed: false, alreadyCompleted: true };

    // Never log, persist, or copy the supplied password to Firestore.
    await authAdmin.updateUser(uid, { password: payload.newPassword });
    await db.runTransaction(async tx => {
        const fresh = await tx.get(userRef);
        if (!fresh.exists || fresh.data()?.disabled === true || fresh.data()?.active === false)
            fail('permission-denied', '帳號已停用或不存在');
        if (!fresh.updateTime?.isEqual(before.updateTime))
            fail('failed-precondition', '帳號設定已變更；密碼已更新，請重新登入確認後重試');
        if (fresh.data()?.mustChangePassword !== true)
            fail('failed-precondition', '管理員已變更強制改密碼設定；請重新登入確認');
        tx.update(userRef, { mustChangePassword: false });
    });
    return { completed: true };
}

function createRequiredPasswordCallable({onCall, HttpsError, getDatabase, getAuthentication}) {
    return onCall({region:'asia-east1'}, async request => {
        try {
            return await completeRequiredPasswordChange(
                getDatabase(), getAuthentication(), request.auth?.uid,
                Number(request.auth?.token?.auth_time), request.data
            );
        } catch (error) {
            if (['unauthenticated', 'permission-denied', 'failed-precondition', 'invalid-argument'].includes(error.code))
                throw new HttpsError(error.code, error.message);
            // An Auth update may have succeeded before the Firestore error. In that
            // event the forced requirement is intentionally still active.
            console.error('Complete required password change failed', error?.code || 'unknown');
            throw new HttpsError('internal', '密碼或帳號設定未完全同步；請用新密碼重新登入，仍有問題請聯絡管理員');
        }
    });
}

module.exports = { completeRequiredPasswordChange, createRequiredPasswordCallable };
