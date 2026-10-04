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
    async function savePdf(kind, pdf, fileName) {
        await ready;
        const handle = handles.get(kind);
        if (!handle) { pdf.save(fileName); return; }
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
    }
    root.DocumentDownloads = {setUser, choose, reset, prepare, savePdf};
    render();
})(typeof window !== 'undefined' ? window : globalThis);
