const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const file=fs.readFileSync(path.join(__dirname,'../src/services/supply-order.js'),'utf8');
const source=file.slice(file.indexOf('async function registerPurchaseIncoming('),file.indexOf('async function cancelOutstandingSupplyRecord('));
function setup({retry=false,failSecond=false,changeAt='',afterCommit,afterDiscard}={}) {
    const po={supplyOrderIds:['S1','S2'],items:[{productId:'stale',warehouseId:'old'}]};
    const records=new Map([['purchaseOrders/PO',{supplyOrderIds:['S1','S2']}]]),movements=[],invalidated=[],writes=[];
    for(const id of ['S1','S2'])records.set(`supplyOrders/${id}`,{type:'PURCHASING_PO',purchaseDocumentId:'PO',
        productKey:id,productId:id,warehouseId:'W',qty:3,receivedQty:0,incomingRegisteredQty:0,fulfillmentType:'WAREHOUSE'});
    let sequence=0,commits=0,failed=false;
    const c=vm.createContext({currentUser:{uid:'buyer'},currentUserRole:'purchaser',currentUserName:'Buyer',
        canCreatePurchaseOrderCapability:()=>true,canAccessPage:()=>true,
        db:{collection:name=>({doc:id=>({key:`${name}/${id||++sequence}`})})},
        supplyOrdersCollection:()=>c.db.collection('supplyOrders'),
        isPurchaseTerminalStatus:status=>['CANCELLED','CLOSED'].includes(status),YushinReceiving:require('../modules/receiving-core.js'),
        warehouseStockDocId:(warehouse,key)=>`${warehouse}__${key}`,inventoryNumbers:require('../modules/inventory-core.js').normalizeStock,
        resolveBrandName:x=>x,brandIdForName:()=>'',buildInventorySearchTokens:()=>[],
        invalidateWarehouseStockCache:(key,warehouse)=>invalidated.push([key,warehouse]),
        async runRoleTransaction(callback){
            for(let attempt=0;attempt<(retry?2:1);attempt++) {
                const pending=[];let writing=false;
                await callback({get:async r=>{
                    assert.equal(writing,false);
                    if(changeAt==='supply'&&r.key==='supplyOrders/S1')c.currentUser={uid:'other'};
                    if(changeAt==='stock'&&r.key==='inventory/S1')c.currentUserRole='admin';
                    if(failSecond&&!failed&&r.key==='inventory/S2'){failed=true;throw new Error('network failed');}
                    return {exists:records.has(r.key),data:()=>structuredClone(records.get(r.key))};
                },set:(r,data,options)=>{writing=true;pending.push([r.key,data,options?.merge]);},
                update:(r,data)=>{writing=true;pending.push([r.key,data,true]);}});
                if(retry&&attempt===0){afterDiscard?.(c,records);continue;}
                pending.forEach(([key,data,merge])=>{
                    records.set(key,structuredClone(merge?{...records.get(key),...data}:data));writes.push(key);
                    if(key.startsWith('inventoryMovements/'))movements.push(data);
                });
                commits++;afterCommit?.(c,commits,records);
            }
        }
    });vm.runInContext(source,c);return {c,po,records,movements,invalidated,writes};
}
test('incoming checkpoints retry callbacks and use actual committed stock identity',async()=>{
    const x=setup({retry:true});await x.c.registerPurchaseIncoming('PO',x.po);
    assert.equal(x.movements.length,2);assert.equal(x.records.get('inventory/S1').incoming,3);
    assert.deepEqual(x.invalidated,[['S1','W'],['S2','W']]);
    const count=x.writes.length;await x.c.registerPurchaseIncoming('PO',x.po);assert.equal(x.writes.length,count);
});
test('later item failure preserves earlier checkpoint and resumes without double incoming',async()=>{
    const x=setup({failSecond:true});await assert.rejects(x.c.registerPurchaseIncoming('PO',x.po),/network failed/);
    assert.equal(x.records.get('supplyOrders/S1').incomingRegisteredQty,3);
    assert.equal(x.records.get('supplyOrders/S2').incomingRegisteredQty,0);
    assert.equal(x.records.has('inventory/S2'),false);
    await x.c.registerPurchaseIncoming('PO',x.po);
    assert.equal(x.movements.length,2);assert.equal(x.records.get('inventory/S1').incoming,3);
    assert.equal(x.records.get('inventory/S2').incoming,3);
});
test('discarded callback stock result cannot invalidate caches after live cancellation wins retry',async()=>{
    const x=setup({retry:true,afterDiscard:(c,records)=>{records.get('purchaseOrders/PO').status='CANCELLED';}});
    await x.c.registerPurchaseIncoming('PO',x.po);
    assert.equal(x.writes.length,0);assert.equal(x.invalidated.length,0);assert.equal(x.movements.length,0);
});
test('incoming refuses missing core and lost purchasing capability before any write',async()=>{
    const x=setup();x.c.YushinReceiving=null;await assert.rejects(x.c.registerPurchaseIncoming('PO',x.po),/Receiving core/);
    assert.equal(x.writes.length,0);
    const y=setup();y.c.canCreatePurchaseOrderCapability=()=>false;
    await assert.rejects(y.c.registerPurchaseIncoming('PO',y.po),/無採購作業權限/);assert.equal(y.writes.length,0);
});
test('live parent cancellation wins over stale open UI snapshot',async()=>{
    const x=setup();x.records.get('purchaseOrders/PO').status='CANCELLED';
    await x.c.registerPurchaseIncoming('PO',x.po);assert.equal(x.writes.length,0);
});
test('incoming rejects missing parent link and mismatched supply ownership',async()=>{
    for(const mutation of ['parent','link','source','type']) {
        const x=setup();
        if(mutation==='parent')x.records.delete('purchaseOrders/PO');
        if(mutation==='link')x.records.get('purchaseOrders/PO').supplyOrderIds=[];
        if(mutation==='source')x.records.get('supplyOrders/S1').purchaseDocumentId='OTHER';
        if(mutation==='type')x.records.get('supplyOrders/S1').type='SALES_SELF_ORDER';
        await assert.rejects(x.c.registerPurchaseIncoming('PO',x.po));assert.equal(x.writes.length,0);
    }
});
test('incoming stops identity changes during either supply or stock reads',async()=>{
    for(const changeAt of ['supply','stock']) {
        const x=setup({changeAt});await assert.rejects(x.c.registerPurchaseIncoming('PO',x.po),/登入身份/);assert.equal(x.writes.length,0);
    }
});
test('identity switch after first committed item stops second checkpoint and cache changes',async()=>{
    const x=setup({afterCommit:(c,count)=>{if(count===1)c.currentUser={uid:'other'};}});
    await assert.rejects(x.c.registerPurchaseIncoming('PO',x.po),/登入身份/);
    assert.equal(x.records.get('supplyOrders/S1').incomingRegisteredQty,3);
    assert.equal(x.records.get('supplyOrders/S2').incomingRegisteredQty,0);
    assert.equal(x.invalidated.length,0);
    x.c.currentUser={uid:'buyer'};await x.c.registerPurchaseIncoming('PO',x.po);
    assert.equal(x.movements.length,2);
});
test('incoming refuses original confirmation actor or role after PDF stage switch',async()=>{
    const x=setup();await assert.rejects(x.c.registerPurchaseIncoming('PO',x.po,{actorUid:'other',actorRole:'purchaser'}),/登入身份/);
    await assert.rejects(x.c.registerPurchaseIncoming('PO',x.po,{actorUid:'buyer',actorRole:'admin'}),/登入身份/);
    assert.equal(x.writes.length,0);
});
test('incoming correction releases exact amount and rejects insufficient company or warehouse totals',async()=>{
    for(const insufficient of ['', 'company', 'warehouse']) {
        const x=setup();x.po.supplyOrderIds=['S1'];
        Object.assign(x.records.get('supplyOrders/S1'),{receivedQty:2,incomingRegisteredQty:3});
        x.records.set('inventory/S1',{incoming:insufficient==='company'?1:3,onHand:7,reserved:2});
        x.records.set('warehouseStocks/W__S1',{incoming:insufficient==='warehouse'?1:3,onHand:5,reserved:1});
        if(insufficient){await assert.rejects(x.c.registerPurchaseIncoming('PO',x.po),/在途保留量不足/);assert.equal(x.writes.length,0);}
        else {await x.c.registerPurchaseIncoming('PO',x.po);assert.equal(x.movements[0].qty,-2);
            assert.equal(x.records.get('inventory/S1').incoming,1);assert.equal(x.records.get('warehouseStocks/W__S1').incoming,1);
            assert.equal(x.records.get('inventory/S1').onHand,7);assert.equal(x.records.get('inventory/S1').reserved,2);}
    }
});
test('incoming validates malformed supply and stock quantities without hiding them by clamping',async()=>{
    for(const patch of [{qty:-1},{qty:'bad'},{qty:null},{receivedQty:4},{receivedQty:false},{incomingRegisteredQty:-1},{incomingRegisteredQty:NaN}]) {
        const x=setup();Object.assign(x.records.get('supplyOrders/S1'),patch);
        await assert.rejects(x.c.registerPurchaseIncoming('PO',x.po));assert.equal(x.writes.length,0);
    }
    for(const incoming of [-1,NaN,null,'',false]) {
        const x=setup();x.records.set('inventory/S1',{incoming});
        await assert.rejects(x.c.registerPurchaseIncoming('PO',x.po));assert.equal(x.writes.length,0);
    }
});
test('direct terminal and fully received supplies never create warehouse incoming',async()=>{
    for(const patch of [{fulfillmentType:'DIRECT_SHIP'},{status:'CLOSED'},{status:'CANCELLED'},{receivedQty:3}]) {
        const x=setup();x.po.supplyOrderIds=['S1'];Object.assign(x.records.get('supplyOrders/S1'),patch);
        await x.c.registerPurchaseIncoming('PO',x.po);assert.equal(x.writes.length,0);
    }
});
test('incoming refuses warehouse fallback and mismatched stock identity',async()=>{
    for(const mutation of ['warehouse','company','stock']) {
        const x=setup();
        if(mutation==='warehouse')delete x.records.get('supplyOrders/S1').warehouseId;
        if(mutation==='company')x.records.set('inventory/S1',{incoming:0,productKey:'OTHER'});
        if(mutation==='stock')x.records.set('warehouseStocks/W__S1',{incoming:0,warehouseId:'OTHER'});
        await assert.rejects(x.c.registerPurchaseIncoming('PO',x.po));assert.equal(x.writes.length,0);
    }
});
