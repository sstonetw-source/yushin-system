const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const all=fs.readFileSync(path.join(__dirname,'../src/services/supply-order.js'),'utf8');
const source=all;
const ui=fs.readFileSync(path.join(__dirname,'../src/features/purchasing/purchase-cancellation-workspace.js'),'utf8');
const demand=require('../modules/procurement-demand-core.js');
function setup({retry=false,failSupply='',changeAt='',manual=false,direct=false,failFinalize=false,changeLinks=false}={}){
    const records=new Map(),movements=[],invalidated=[],writes=[];let seq=0,failed=false;
    records.set('purchaseOrders/PO',{supplyOrderIds:['S1','S2']});
    for(const id of ['S1','S2']){
        records.set(`supplyOrders/${id}`,{type:manual?'PURCHASING_MANUAL':'PURCHASING_PO',...(manual?{internalNo:'PO'}:{purchaseDocumentId:'PO'}),
            qty:5,receivedQty:2,incomingRegisteredQty:direct?0:3,productKey:id,warehouseId:direct?'':'W',fulfillmentType:direct?'DIRECT_SHIP':'WAREHOUSE',
            orderId:id,itemId:'i',demandId:id,status:'PARTIAL_RECEIPT'});
        records.set(`orders/${id}`,{items:[{itemId:'i',supplyOrderedQty:5,receivedQty:2}]});
        records.set(`procurementDemands/${id}`,demand.normalizeDemand({demandId:id,requestedQty:5,orderedQty:5,receivedQty:2}));
        records.set(`inventory/${id}`,{productKey:id,onHand:10,reserved:4,incoming:3});
        records.set(`warehouseStocks/W__${id}`,{productKey:id,warehouseId:'W',onHand:6,reserved:2,incoming:3});
    }
    const c=vm.createContext({currentUser:{uid:'buyer'},currentUserRole:'purchaser',currentUserName:'Buyer',
        canCreatePurchaseOrderCapability:()=>true,db:{collection:name=>({doc:id=>({key:`${name}/${id||++seq}`})})},
        supplyOrdersCollection:()=>c.db.collection('supplyOrders'),procurementDemandRef:id=>c.db.collection('procurementDemands').doc(id),
        procurementDemandDocument:d=>d,YushinProcurementDemand:demand,YushinReceiving:require('../modules/receiving-core.js'),
        isPurchaseTerminalStatus:s=>['CANCELLED','CLOSED'].includes(s),normalizedOrderItems:o=>o.items.map(i=>({...i})),orderWorkIndexFields:()=>({}),
        warehouseStockDocId:(w,p)=>`${w}__${p}`,inventoryNumbers:require('../modules/inventory-core.js').normalizeStock,
        invalidateWarehouseStockCache:(p,w)=>invalidated.push([p,w]),invalidateProcurementDemandQueue:()=>{},
        async runRoleTransaction(callback){
            for(let attempt=0;attempt<(retry?2:1);attempt++){
                const pending=[];let writing=false;
                const result=await callback({get:async r=>{
                    assert.equal(writing,false);
                    if(changeAt&&r.key===changeAt)c.currentUser={uid:'other'};
                    if(failSupply&&!failed&&r.key===`supplyOrders/${failSupply}`){failed=true;throw new Error('network failed');}
                    return {exists:records.has(r.key),data:()=>structuredClone(records.get(r.key))};
                },set:(r,data)=>{writing=true;pending.push([r.key,data]);},update:(r,data)=>{
                    writing=true;if(failFinalize&&!failed&&r.key==='purchaseOrders/PO'){failed=true;throw new Error('finalize failed');}
                    pending.push([r.key,data]);}});
                if(retry&&attempt===0)continue;
                pending.forEach(([key,data])=>{records.set(key,structuredClone({...records.get(key),...data}));writes.push(key);if(key.startsWith('inventoryMovements/'))movements.push(data);});
                if(changeLinks&&pending.some(([key,data])=>key==='supplyOrders/S2'&&data.status==='CLOSED'))records.get('purchaseOrders/PO').supplyOrderIds=['S1'];
                return result;
            }
        }
    });vm.runInContext(source,c);return {c,records,movements,invalidated,writes};
}
test('common cancellation atomically closes partial supply and releases exact linked quantities',async()=>{
    for(const manual of [false,true]){
        const x=setup({manual,retry:true});const result=await x.c.cancelOutstandingSupplyRecord('PO','S1','Supplier stopped');
        assert.equal(result.terminalStatus,'CLOSED');assert.equal(result.cancelledQty,3);assert.equal(x.movements.length,1);
        assert.equal(x.records.get('orders/S1').items[0].supplyOrderedQty,2);
        assert.equal(x.records.get('procurementDemands/S1').orderedQty,2);
        assert.equal(x.records.get('inventory/S1').incoming,0);assert.equal(x.records.get('inventory/S1').onHand,10);
        assert.equal(x.records.get('inventory/S1').reserved,4);assert.equal(x.records.get('warehouseStocks/W__S1').incoming,0);
        const count=x.writes.length;await x.c.cancelOutstandingSupplyRecord('PO','S1','Retry');assert.equal(x.writes.length,count);
    }
});
test('direct cancellation has no warehouse movement and zero receipt becomes CANCELLED',async()=>{
    const x=setup({direct:true});Object.assign(x.records.get('supplyOrders/S1'),{receivedQty:0});
    x.records.get('orders/S1').items[0].receivedQty=0;x.records.get('procurementDemands/S1').receivedQty=0;
    const result=await x.c.cancelOutstandingSupplyRecord('PO','S1','Stopped');
    assert.equal(result.terminalStatus,'CANCELLED');assert.equal(x.movements.length,0);
    assert.equal(x.records.get('orders/S1').items[0].supplyOrderedQty,0);
});
test('cancellation underflow in any linked total refuses the whole transaction',async()=>{
    for(const target of ['inventory/S1','warehouseStocks/W__S1','orders/S1','procurementDemands/S1']){
        const x=setup();const row=x.records.get(target);
        if(target.startsWith('orders'))row.items[0].supplyOrderedQty=3;
        else if(target.startsWith('procurement'))row.orderedQty=3;
        else row.incoming=1;
        await assert.rejects(x.c.cancelOutstandingSupplyRecord('PO','S1','Stopped'),/不足/);
        assert.equal(x.writes.length,0);assert.equal(x.records.get('supplyOrders/S1').status,'PARTIAL_RECEIPT');
    }
});
test('cancellation rejects missing source records wrong ownership and malformed quantities',async()=>{
    for(const mutation of ['order','demand','parent','warehouse','type','owner','qty','received','registered','identity']){
        const x=setup(),s=x.records.get('supplyOrders/S1');
        if(mutation==='order')x.records.delete('orders/S1');
        if(mutation==='demand')x.records.delete('procurementDemands/S1');
        if(mutation==='parent')x.records.delete('purchaseOrders/PO');
        if(mutation==='warehouse')delete s.warehouseId;
        if(mutation==='type')s.type='SALES_SELF_ORDER';
        if(mutation==='owner')s.purchaseDocumentId='OTHER';
        if(mutation==='qty')s.qty=-1;
        if(mutation==='received')s.receivedQty=6;
        if(mutation==='registered')s.incomingRegisteredQty=NaN;
        if(mutation==='identity')x.records.get('warehouseStocks/W__S1').warehouseId='OTHER';
        await assert.rejects(x.c.cancelOutstandingSupplyRecord('PO','S1','Stopped'));assert.equal(x.writes.length,0);
    }
});
test('cancellation checks identity after supply and linked reads and validates reason and capability',async()=>{
    for(const changeAt of ['supplyOrders/S1','procurementDemands/S1']){
        const x=setup({changeAt});await assert.rejects(x.c.cancelOutstandingSupplyRecord('PO','S1','Stopped'),/登入身份/);assert.equal(x.writes.length,0);
    }
    const x=setup();await assert.rejects(x.c.cancelOutstandingSupplyRecord('PO','S1','  '),/原因/);
    await assert.rejects(x.c.cancelOutstandingSupplyRecord('PO','S1','Stopped',{actorUid:'buyer',actorRole:'admin'}),/登入身份/);
    x.c.canCreatePurchaseOrderCapability=()=>false;await assert.rejects(x.c.cancelOutstandingSupplyRecord('PO','S1','Stopped'),/權限/);
});
test('whole PO stop resumes after partial supply failure and finalizes from live terminal records',async()=>{
    const x=setup({retry:true,failSupply:'S2'});
    await assert.rejects(x.c.stopPurchaseOrderOutstanding('PO','Stopped'),/network failed/);
    assert.equal(x.records.get('supplyOrders/S1').status,'CLOSED');assert.equal(x.records.get('purchaseOrders/PO').status,undefined);
    const result=await x.c.stopPurchaseOrderOutstanding('PO','Stopped');
    assert.equal(result.patch.status,'CLOSED');assert.equal(result.cancelledQty,6);
    assert.equal(x.movements.length,2);assert.equal(x.records.get('purchaseOrders/PO').stoppedQty,6);
    const count=x.writes.length;await x.c.stopPurchaseOrderOutstanding('PO','Retry');assert.equal(x.writes.length,count);
});
test('whole PO stop does not finalize when identity changes before second supply',async()=>{
    const x=setup({changeAt:'supplyOrders/S2'});await assert.rejects(x.c.stopPurchaseOrderOutstanding('PO','Stopped'),/登入身份/);
    assert.equal(x.records.get('supplyOrders/S1').status,'CLOSED');assert.equal(x.records.get('supplyOrders/S2').status,'PARTIAL_RECEIPT');
    assert.equal(x.records.get('purchaseOrders/PO').status,undefined);
});
test('failed PO finalization retries without repeating completed supply releases',async()=>{
    const x=setup({failFinalize:true});await assert.rejects(x.c.stopPurchaseOrderOutstanding('PO','Stopped'),/finalize failed/);
    assert.equal(x.records.get('purchaseOrders/PO').status,undefined);assert.equal(x.movements.length,2);
    const result=await x.c.stopPurchaseOrderOutstanding('PO','Stopped');
    assert.equal(result.patch.status,'CLOSED');assert.equal(x.movements.length,2);
});
test('finalization rejects changed parent supply membership after individual commits',async()=>{
    const x=setup({changeLinks:true});await assert.rejects(x.c.stopPurchaseOrderOutstanding('PO','Stopped'),/供應連結已變更/);
    assert.equal(x.records.get('purchaseOrders/PO').status,undefined);assert.equal(x.movements.length,2);
});
test('fully received PO stop makes no mutations and terminal corruption is rejected',async()=>{
    const x=setup();for(const id of ['S1','S2'])Object.assign(x.records.get(`supplyOrders/${id}`),{receivedQty:5,incomingRegisteredQty:0,status:'RECEIVED'});
    const result=await x.c.stopPurchaseOrderOutstanding('PO','Stopped');assert.equal(result.patch,null);assert.equal(x.writes.length,0);
    const y=setup();await y.c.cancelOutstandingSupplyRecord('PO','S1','Stopped');y.records.get('supplyOrders/S1').closedQty=2;
    const count=y.writes.length;await assert.rejects(y.c.cancelOutstandingSupplyRecord('PO','S1','Retry'),/已停止數量/);assert.equal(y.writes.length,count);
});
test('successful cancellation followed by UI failure is not reported as an uncommitted transaction',async()=>{
    for(const wholePo of [false,true]){
        const alerts=[],supply={id:'S1',type:'PURCHASING_PO',purchaseDocumentId:'PO',qty:5,receivedQty:2};
        const c=vm.createContext({window:{},currentUser:{uid:'buyer'},currentUserRole:'purchaser',canCreatePurchaseOrderCapability:()=>true,
            purchaseCancellationInProgress:new Set(),poListCache:[{id:'PO'}],poHistorySearchResults:[],supplyReceivingCache:[supply],
            db:{collection:()=>({doc:()=>({get:async()=>({id:'PO',exists:true,data:()=>({supplyOrderIds:['S1']})})})})},
            supplyOrdersCollection:()=>({doc:()=>({get:async()=>({id:'S1',exists:true,data:()=>supply})})}),firestoreReadWithTimeout:p=>p,
            isPurchaseTerminalStatus:()=>false,prompt:()=> 'Stopped',alert:x=>alerts.push(x),document:{getElementById:()=>null},console,
            invalidateWarehouseStockCache:()=>{},invalidateProcurementDemandQueue:()=>{},
            purchaseHistorySupplyCache:{set:()=>{throw new Error('cache failed');}},writeAppDataCache:()=>{throw new Error('cache failed');},
            cancelOutstandingSupplyRecord:async()=>({terminalStatus:'CLOSED',cancelledQty:3}),
            stopPurchaseOrderOutstanding:async()=>({patch:{status:'CLOSED'},cancelledQty:3,supplyIds:['S1'],affectedOrderIds:[]})});
        const start=ui.indexOf(wholePo?'window.cancelPurchaseOrderOutstanding =':'window.cancelSupplyOutstanding =');
        const end=wholePo?ui.length:ui.indexOf('\nwindow.cancelPurchaseOrderOutstanding',start);
        vm.runInContext(ui.slice(start,end),c);
        await (wholePo?c.window.cancelPurchaseOrderOutstanding('PO'):c.window.cancelSupplyOutstanding('S1'));
        assert.equal(alerts.length,1);assert.match(alerts[0],/已完成，但畫面更新失敗/);
        assert.equal(c.purchaseCancellationInProgress.size,0);
    }
});
test('supply transactions execute without browser or cache collaborators',async()=>{
    const x=setup();delete x.c.invalidateWarehouseStockCache;delete x.c.invalidateProcurementDemandQueue;
    const result=await x.c.stopPurchaseOrderOutstanding('PO','Stopped');
    assert.equal(result.patch.status,'CLOSED');assert.equal(x.movements.length,2);assert.equal(x.invalidated.length,0);
});
test('whole PO forwards notifications only after committed supply checkpoints, not discarded callbacks',async()=>{
    const x=setup({retry:true}),notifications=[],demands=[];
    await x.c.stopPurchaseOrderOutstanding('PO','Stopped',{
        onStockCommitted:(key,warehouse)=>{assert.equal(x.records.get('supplyOrders/'+key).status,'CLOSED');notifications.push([key,warehouse]);},
        onDemandChanged:id=>{assert.equal(x.records.get('procurementDemands/'+id).orderedQty,2);demands.push(id);}
    });
    assert.deepEqual(notifications,[['S1','W'],['S2','W']]);assert.deepEqual(demands,['S1','S2']);
});
test('notification failure after single cancellation reports committed supply and retry never double releases',async()=>{
    for(const hook of ['onStockCommitted','onDemandChanged']){
        const x=setup();await assert.rejects(x.c.cancelOutstandingSupplyRecord('PO','S1','Stopped',{[hook]:()=>{throw Error('view cache failed');}}),e=>e.supplyCommitted&&e.supplyResult.cancelledQty===3);
        assert.equal(x.records.get('inventory/S1').incoming,0);await x.c.cancelOutstandingSupplyRecord('PO','S1','Retry');
        assert.equal(x.movements.length,1);assert.equal(x.records.get('orders/S1').items[0].supplyOrderedQty,2);
    }
});
test('notification interruption during whole PO stop preserves completed line and leaves finalization pending',async()=>{
    const x=setup();await assert.rejects(x.c.stopPurchaseOrderOutstanding('PO','Stopped',{onDemandChanged:()=>{throw Error('view cache failed');}}),e=>e.supplyCommitted);
    assert.equal(x.records.get('supplyOrders/S1').status,'CLOSED');assert.equal(x.records.get('supplyOrders/S2').status,'PARTIAL_RECEIPT');
    assert.equal(x.records.get('purchaseOrders/PO').status,undefined);await x.c.stopPurchaseOrderOutstanding('PO','Retry');assert.equal(x.movements.length,2);
});
