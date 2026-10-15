// 全系統寫入按鍵共用狀態：立即顯示處理中、防止重複點擊，完成或失敗後一致恢復。
function productOperationErrorMessage(action, err) {
    const code = String(err?.code || '').replace(/^firestore\//, '');
    if (code === 'permission-denied') return `${action}失敗：目前帳號沒有權限。請聯絡管理員確認。`;
    if (code === 'unauthenticated') return `${action}失敗：登入已失效。請重新登入後再試。`;
    if (['unavailable', 'deadline-exceeded', 'resource-exhausted'].includes(code))
        return `${action}未完成：連線或服務暫時無法使用。請稍後重試。`;
    const detail = !code && /[\u3400-\u9fff]/.test(String(err?.message || '')) ? err.message : '';
    return `${action}失敗${detail ? '：' + detail : '。'}請確認資料後重試；若仍失敗，請聯絡管理員。`;
}

function beginActionButton(button, busyText = '處理中…') {
    if (!button || button.dataset.actionBusy === '1') return null;
    const state = { text: button.textContent, disabled: button.disabled };
    button.dataset.actionBusy = '1';
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    if (busyText) button.textContent = busyText;
    return state;
}
function endActionButton(button, state, finalText = '') {
    if (!button || !state) return;
    button.dataset.actionBusy = '';
    button.removeAttribute('aria-busy');
    button.disabled = state.disabled;
    button.textContent = finalText || state.text;
}
function actionButtonFromEventOrSelector(selector = '') {
    const eventButton = window.event?.currentTarget?.closest?.('button');
    return eventButton || (selector ? document.querySelector(selector) : null);
}

