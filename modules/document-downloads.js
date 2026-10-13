/* Local PDF destinations are scoped to the signed-in user and this browser. */
(function(root) {
    'use strict';
    let userId = '', generation = 0;
    const handles = new Map();
    let ready = Promise.resolve();
    const supported = () => typeof root.showDirectoryPicker === 'function' && !!root.indexedDB;
    const key = kind => `${userId}||${kind}`;
    async function database() {
        return new Promise((resolve, reject) => {
            const request = root.indexedDB.open('yushin-document-downloads', 1);
            request.onupgradeneeded = () => request.result.createObjectStore('folders');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }
    async function stored(operation, id, handle) {
        const db = await database();
        try {
            return await new Promise((resolve, reject) => {
                const tx = db.transaction('folders', operation === 'get' ? 'readonly' : 'readwrite');
                const store = tx.objectStore('folders');
                const request = operation === 'put' ? store.put(handle, id) : store[operation](id);
                tx.oncomplete = () => resolve(request.result);
                tx.onerror = () => reject(tx.error);
                tx.onabort = () => reject(tx.error || new Error('資料夾設定未儲存'));
            });
        } finally { db.close(); }
    }
    function render() {
        root.document?.querySelectorAll('[data-download-folder-button]').forEach(el=>{el.hidden=!supported();});
        root.document?.querySelectorAll('[data-download-folder]').forEach(el => {
            const handle = handles.get(el.dataset.downloadFolder);
            el.textContent = handle ? `下載資料夾：${handle.name}` : supported() ? '使用瀏覽器預設下載' : '此瀏覽器使用預設下載；可在瀏覽器設定調整位置';
        });
    }
    async function setUser(id) {
        userId = String(id || '');
        handles.clear();
        const version = ++generation;
        render();
        ready = supported() && userId ? Promise.all(['quote', 'purchase'].map(async kind => {
            const handle = await stored('get', key(kind));
            if (version === generation && handle) handles.set(kind, handle);
        })).catch(() => {}).then(render) : Promise.resolve();
        return ready;
    }
    async function choose(kind) {
        if (!supported()) throw new Error('此瀏覽器不支援選擇下載資料夾。請在瀏覽器的下載設定調整儲存位置，或使用支援此功能的桌面瀏覽器。');
        if (!userId) throw new Error('請先登入。');
        const id = key(kind), version = generation;
        const handle = await root.showDirectoryPicker({id:`yushin-${kind}`, mode:'readwrite'});
        await ready;
        if (version !== generation) throw new Error('登入帳號已變更，請重新設定。');
        await stored('put', id, handle);
        handles.set(kind, handle);
        render();
    }
    async function reset(kind) {
        await ready;
        if (supported() && userId) await stored('delete', key(kind));
        handles.delete(kind);
        render();
    }
    async function prepare(kind) {
        await ready;
        const handle = handles.get(kind);
        if (!handle) return;
        if (await handle.queryPermission({mode:'readwrite'}) === 'granted') return;
        if (await handle.requestPermission({mode:'readwrite'}) !== 'granted') {
            throw new Error('未取得下載資料夾寫入權限，請重新設定資料夾或選「使用預設下載」。');
        }
    }
    function sharePdfFile(file, pdf, fileName) {
        // PDF rendering is asynchronous. A fresh click supplies the user activation
        // required by Web Share; never include a blob URL or page URL in its payload.
        return new Promise((resolve, reject) => {
            const dialog = root.document.createElement('dialog');
            dialog.className = 'page-help-dialog';
            dialog.setAttribute('aria-label', 'PDF 文件已準備');
            const body = root.document.createElement('div');
            body.className = 'page-help-body';
            const title = root.document.createElement('h3');
            title.textContent = 'PDF 文件已準備';
            const name = root.document.createElement('p');
            name.textContent = fileName;
            const message = root.document.createElement('p');
            message.setAttribute('role', 'status');
            const actions = root.document.createElement('div');
            actions.className = 'toolbar';
            const button = (text, className) => {
                const el = root.document.createElement('button');
                el.type = 'button'; el.className = className; el.textContent = text;
                actions.appendChild(el); return el;
            };
            const share = button('分享 PDF 文件', 'btn-primary');
            const download = button('下載 PDF', 'btn-secondary');
            const cancel = button('關閉', 'btn-secondary');
            let sharing = false;
            const finish = result => { dialog.close(); dialog.remove(); resolve(result); };
            share.onclick = async () => {
                if (sharing) return;
                sharing = true;
                share.disabled = download.disabled = cancel.disabled = true;
                message.textContent = '正在開啟分享…';
                try {
                    await root.navigator.share({files: [file]});
                    finish(true);
                } catch (err) {
                    message.textContent = err.name === 'AbortError'
                        ? '已取消分享，可重新分享或下載 PDF。'
                        : '無法分享此文件，請重試或選擇下載 PDF。';
                } finally {
                    sharing = false;
                    share.disabled = download.disabled = cancel.disabled = false;
                }
            };
            download.onclick = () => {
                try { pdf.save(fileName); finish(true); }
                catch (err) { dialog.close(); dialog.remove(); reject(err); }
            };
            cancel.onclick = () => finish(false);
            dialog.addEventListener('cancel', event => { event.preventDefault(); if (!sharing) finish(false); });
            body.append(title, name, message, actions);
            dialog.appendChild(body);
            root.document.body.appendChild(dialog);
            dialog.showModal();
        });
    }
    async function savePdf(kind, pdf, fileName) {
        await ready;
        const handle = handles.get(kind);
        if (!handle) {
            if (typeof root.File === 'function' && typeof root.navigator?.share === 'function'
                && typeof root.navigator?.canShare === 'function') {
                const file = new root.File([pdf.output('blob')], fileName, {type: 'application/pdf'});
                if (root.navigator.canShare({files: [file]})) return sharePdfFile(file, pdf, fileName);
            }
            pdf.save(fileName); return true;
        }
        if (await handle.queryPermission({mode:'readwrite'}) !== 'granted') throw new Error('下載資料夾權限已失效，請重新設定資料夾。');
        // Never silently overwrite a prior export with the same document name.
        const safeName = fileName.replace(/[\\/\u0000]/g, '_');
        const dot = safeName.lastIndexOf('.');
        const base = dot > 0 ? safeName.slice(0,dot) : safeName;
        const ext = dot > 0 ? safeName.slice(dot) : '';
        let name = safeName;
        for (let suffix = 1;; suffix++) {
            try { await handle.getFileHandle(name); }
            catch (err) { if (err.name === 'NotFoundError') break; throw err; }
            name = `${base} (${suffix})${ext}`;
        }
        const file = await handle.getFileHandle(name, {create:true});
        const writable = await file.createWritable();
        try { await writable.write(pdf.output('blob')); await writable.close(); }
        catch (err) { await writable.abort().catch(() => {}); throw err; }
        return true;
    }
    root.DocumentDownloads = {setUser, choose, reset, prepare, savePdf};
    render();
})(typeof window !== 'undefined' ? window : globalThis);
