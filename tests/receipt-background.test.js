const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../app.js'),'utf8');
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function setup(storage=new Map()){
    const calls=[],notices=[],refreshes=[];
    let selected=[row(2,5)];
    const controls={receiptTaskStatus:{hidden:true,innerHTML:''}};
    const x=vm.createContext({window:{addEventListener(){}},currentUser:{uid:'U1'},currentUserRole:'admin',canReceiveInventoryCapability:()=>true,
        poReceiptTargetId:'supply:S1',poReceiptOperationId:'OP1',
        sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
        document:{getElementById:id=>controls[id]||null,querySelectorAll:selector=>selector==='#poReceiptBatchBody tr'?selected:[]},
        supplyReceivingCache:[{id:'S1',itemCode:'A'},{id:'S2',itemCode:'B'}],pendingSupplyCache:[],
        inventoryReceivingVisible:false,purchasingReceivingLoadPromise:null,activeReceivingSupplyLoadPromise:null,markMainPageDirty:()=>{},canAccessPage:()=>false,getDataScope:()=> 'none',
        loadInventory:async()=>{},loadPurchasingReceivingQueue:async()=>{},refreshAffectedOrderCaches:async ids=>refreshes.push(ids),
        escapeHtml:s=>s,escapeAttr:s=>s,showActionFeedback:(...args)=>notices.push(args),alert:s=>notices.push(['alert',s]),
        ensureReceiptOperationId:id=>'OP-'+id,clearReceiptOperationId:(...args)=>calls.push({clear:args}),
        closePoReceiptBatch:()=>{calls.push({closed:true});x.poReceiptTargetId='';selected=[];},
        receiveSupplyOrderRecord:(...args)=>{const d=deferred();calls.push({args,...d});return d.promise;},console
    });
    const start=source.indexOf('const receiptTaskJobs = new Map();');const end=source.indexOf('\nfunction purchaseItemsFromSavedPo',start);
    vm.runInContext(source.slice(start,end),x);
    return {x,calls,notices,storage,controls,select:(id,operation,qty=3)=>{x.poReceiptTargetId='supply:'+id;x.poReceiptOperationId=operation;selected=[row(qty,5)];}};
}
function row(qty,max,index=0){
    const fields={'.po-receive-select':{checked:true},'.po-receive-qty':{value:String(qty),max:String(max)},'.po-receive-lot':{value:'LOT'},'.po-receive-expiry':{value:'2027-01-01'}};
    return {dataset:{index:String(index)},querySelector:key=>fields[key]};
}
test('confirm closes the modal before the receiving transaction completes',async()=>{
    const {x,calls,controls}=setup();const pending=x.window.savePoReceiptBatch();
    assert.equal(calls[0].closed,true);assert.equal(calls[1].args[0],'S1');
    assert.equal(controls.receiptTaskStatus.hidden,false);assert.match(controls.receiptTaskStatus.innerHTML,/到貨處理中/);
    calls[1].resolve([]);await pending;assert.equal(controls.receiptTaskStatus.hidden,true);
});
test('a different supply can receive concurrently while duplicate submission stays blocked',async()=>{
    const {x,calls,select}=setup();const p1=x.window.savePoReceiptBatch();
    select('S1','OP1');await x.window.savePoReceiptBatch();assert.equal(calls.filter(c=>c.args).length,1);
    select('S2','OP2',3);const p2=x.window.savePoReceiptBatch();
    assert.equal(calls.filter(c=>c.args).length,2);
    const transactions=calls.filter(c=>c.args);transactions[0].resolve([]);transactions[1].resolve([]);await Promise.all([p1,p2]);
});
test('opening another receipt never changes the first frozen quantity lot expiry or operation ID',async()=>{
    const {x,calls,select}=setup();const p1=x.window.savePoReceiptBatch();
    select('S2','OP2',3);const p2=x.window.savePoReceiptBatch();
    const first=calls.find(c=>c.args);assert.deepEqual(first.args,['S1',2,'LOT','2027-01-01','OP1-0']);
    calls.filter(c=>c.args).forEach(c=>c.resolve([]));await Promise.all([p1,p2]);
});
test('uncertain failure keeps original details and retries the same receipt ID',async()=>{
    const {x,calls,storage,controls}=setup();const pending=x.window.savePoReceiptBatch();
    const first=calls.find(c=>c.args);first.reject(Error('offline'));await pending;
    assert.match(controls.receiptTaskStatus.innerHTML,/用原資料重試/);
    assert.equal(JSON.parse(storage.get('yushin-receipt-tasks:U1'))[0].entries[0].qty,2);
    const retry=x.window.retryReceiptTask('S1');const transactions=calls.filter(c=>c.args);
    assert.deepEqual(transactions[1].args,transactions[0].args);transactions[1].resolve([]);await retry;
    assert.equal(JSON.parse(storage.get('yushin-receipt-tasks:U1')).length,0);
});
test('post-commit allocation failure identifies committed stock and reuses operation ID',async()=>{
    const {x,calls,controls}=setup();const pending=x.window.savePoReceiptBatch();
    calls.find(c=>c.args).reject(Object.assign(Error('allocation'),{code:'receipt-allocation-pending',receiptCommitted:true}));await pending;
    assert.match(controls.receiptTaskStatus.innerHTML,/已入庫，庫存分配尚未完成/);
    const retry=x.window.retryReceiptTask('S1');const transactions=calls.filter(c=>c.args);
    assert.equal(transactions[1].args[4],'OP1-0');transactions[1].resolve([]);await retry;
});
test('reload restores an unresolved job without issuing new writes until explicit retry',async()=>{
    const storage=new Map();const a=setup(storage);const pending=a.x.window.savePoReceiptBatch();
    const b=setup(storage);b.x.restoreReceiptTasks();b.x.renderReceiptTasks();assert.equal(b.calls.length,0);
    const retry=b.x.window.retryReceiptTask('S1');assert.deepEqual(b.calls[0].args,a.calls[1].args);
    b.calls[0].resolve([]);await retry;a.calls[1].resolve([]);await pending;
});
test('receipt jobs belong to the submitting user and cannot be retried after switching accounts',async()=>{
    const {x,calls}=setup();const pending=x.window.savePoReceiptBatch();calls[1].reject(Error('offline'));await pending;
    x.currentUser={uid:'U2'};await x.window.retryReceiptTask('S1');assert.equal(calls.filter(c=>c.args).length,1);
    x.renderReceiptTasks();
});
test('invalid quantity never closes the form or queues a background write',async()=>{
    for(const qty of [0,-1,NaN,6,Infinity]){
        const {x,calls,select,notices}=setup();select('S1','OP1',qty);await x.window.savePoReceiptBatch();
        assert.equal(calls.length,0);assert.equal(notices[0][0],'alert');
    }
});
test('a failed refresh after confirmed receipt is not presented as another receipt retry',async()=>{
    const {x,calls,controls,storage}=setup();vm.runInContext("refreshReceiptTaskViews=async()=>{throw Error('refresh');}",x);
    const pending=x.window.savePoReceiptBatch();calls[1].resolve([]);await pending;
    assert.equal(controls.receiptTaskStatus.hidden,true);assert.equal(JSON.parse(storage.get('yushin-receipt-tasks:U1')).length,0);
});
