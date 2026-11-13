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
    // Keep the original icon/markup; textContent alone loses it after the request.
    const state = { text: button.textContent, html: typeof button.innerHTML === 'string' ? button.innerHTML : null,
        disabled: button.disabled };
    button.dataset.actionBusy = '1';
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.classList?.add('is-action-pending');
    if (busyText) button.textContent = busyText;
    return state;
}
function endActionButton(button, state, finalText = '') {
    if (!button || !state) return;
    button.dataset.actionBusy = '';
    button.removeAttribute('aria-busy');
    button.classList?.remove('is-action-pending');
    button.disabled = state.disabled;
    if (finalText) button.textContent = finalText;
    else if (state.html !== null) button.innerHTML = state.html;
    else button.textContent = state.text;
}
function actionButtonFromEventOrSelector(selector = '') {
    const eventButton = window.event?.currentTarget?.closest?.('button');
    return eventButton || (selector ? document.querySelector(selector) : null);
}

// Shared presentation-only state for work-list actions. Business writes, retry
// credentials and authorization stay with their existing services. Keeping this
// overlay separate from cached records prevents a stale list refresh from
// making an in-flight action appear actionable again.
const uiWorkActions = new Map();
function uiWorkActionKey(scope, id, uid = currentUser?.uid, role = currentUserRole) {
    return JSON.stringify([uid || '', role || '', String(scope), String(id)]);
}
function uiWorkActionPending(scope, id) {
    return uiWorkActions.has(uiWorkActionKey(scope, id));
}
function uiWorkResultUncertain(error) {
    const code = String(error?.code || '').replace(/^(?:firestore|functions)\//, '').toLowerCase();
    if (['permission-denied', 'unauthenticated', 'invalid-argument', 'failed-precondition', 'not-found', 'already-exists'].includes(code)) return false;
    if (['unavailable', 'deadline-exceeded', 'cancelled', 'unknown', 'network-request-failed', 'firestore-read-timeout'].includes(code)) return true;
    // A plain Error can be thrown after a successful commit (e.g. lost reply or
    // failed cache repaint). Without a trustworthy rejection code, err on the
    // side of requiring authoritative reconciliation rather than permitting a
    // new business transaction from the old card.
    return true;
}
function renderUiWorkActions() {
    if (typeof document === 'undefined' || !document.body?.appendChild || !document.createElement) return;
    let panel = document.getElementById('uiWorkActionStatus');
    const jobs = [...uiWorkActions.values()].filter(job =>
        job.uid === currentUser?.uid && job.role === currentUserRole && (job.state !== 'unknown' || !job.isVisible || job.isVisible()));
    if (!jobs.length) { if (panel) panel.hidden = true; return; }
    if (!panel) {
        panel = document.createElement('aside');
        panel.id = 'uiWorkActionStatus';
        panel.className = 'ui-work-action-status no-print';
        panel.setAttribute('role', 'status');
        panel.setAttribute('aria-live', 'polite');
        document.body.appendChild(panel);
    }
    panel.hidden = false;
    const running = jobs.filter(job => job.state === 'pending');
    const uncertain = jobs.filter(job => job.state === 'unknown');
    panel.replaceChildren();
    const summary = document.createElement('strong');
    summary.textContent = `背景處理中 ${running.length} 筆${uncertain.length ? `・待確認 ${uncertain.length} 筆` : ''}`;
    panel.appendChild(summary);
    jobs.slice(0, 4).forEach(job => {
        const line = document.createElement('div');
        line.textContent = `${job.label}：${job.state === 'unknown' ? '結果待確認，請核對原交易' : '處理中…'}`;
        panel.appendChild(line);
        if (job.state === 'unknown' && typeof job.onVerify === 'function') {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn-small btn-secondary';
            button.textContent = '核對原操作憑證';
            button.onclick = () => {
                if (job.uid !== currentUser?.uid || job.role !== currentUserRole) return;
                try { job.onVerify(); } catch (error) { console.warn('原操作憑證核對失敗', error); }
            };
            panel.appendChild(button);
        }
    });
}
function clearUiWorkActions() {
    uiWorkActions.clear();
    renderUiWorkActions();
}
function beginUiWorkAction(scope, id, label, onUpdate = null, options = {}) {
    const uid = currentUser?.uid, role = currentUserRole;
    if (!uid || !id) return null;
    const key = uiWorkActionKey(scope, id, uid, role);
    const existing = uiWorkActions.get(key);
    if (existing && !(existing.state === 'unknown' && options.resume === true)) return null;
    const job = existing || { uid, role, label: String(label || '工作'), state: 'pending' };
    job.state = 'pending';
    if (typeof options.onVerify === 'function') job.onVerify = options.onVerify;
    if (typeof options.isVisible === 'function') job.isVisible = options.isVisible;
    uiWorkActions.set(key, job);
    const refresh = () => {
        renderUiWorkActions();
        if (uid === currentUser?.uid && role === currentUserRole && typeof onUpdate === 'function') {
            try { onUpdate(); } catch (error) { console.warn('操作畫面更新失敗', error); }
        }
    };
    refresh();
    return Object.freeze({
        finish(outcome = 'success') {
            if (uiWorkActions.get(key) !== job) return;
            if (outcome === 'unknown') job.state = 'unknown';
            else uiWorkActions.delete(key);
            refresh();
        }
    });
}

