// C-class production cutover removed all order, purchase and stock documents.
// Clear browser-only historical transaction snapshots once before app.js loads.
// Never delete quotations, customers, equipment, forecasts or unfinished drafts.
(function clearPreCutoverTransactionSnapshots(){
    try {
        const path=String(globalThis.location?.pathname||'');
        if(globalThis.location?.origin!=='https://sstonetw-source.github.io'
            ||!(path==='/yushin-system'||path.startsWith('/yushin-system/')))return;
        const marker='yushin-transaction-cache-cutover:20261111';
        if(localStorage.getItem(marker)==='done')return;
        const obsolete=[];
        for(let i=0;i<localStorage.length;i++){
            const key=localStorage.key(i);
            if(/^yushin-data-cache:v[12]:/.test(key)
                &&/:(orders|inventory|purchase-history)$/.test(key))obsolete.push(key);
        }
        for(const key of obsolete)localStorage.removeItem(key);
        localStorage.setItem(marker,'done');
    }catch(_){/* Cache maintenance must not block authentication or startup. */}
})();
