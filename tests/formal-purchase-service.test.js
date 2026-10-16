const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const core=require('../modules/procurement-demand-core.js');
const service=fs.readFileSync(path.join(__dirname,'../src/services/formal-purchase-order.js'),'utf8');
const editor=fs.readFileSync(path.join(__dirname,'../src/features/purchasing/purchase-order-editor.js'),'utf8');
const validator=editor.slice(editor.indexOf('function assertPurchaseLinesAvailable('),editor.indexOf('function poPdfFileName('));
function setup({retry=false,fail=false,changeAtRead=false,stock=false}={}) {
    const item={itemId:'i',productId:'p',itemCode:'P',itemName:'Item',brand:'Brand',qty:3,supplyOrderedQty:0,fulfillmentType:'DIRECT_SHIP'};
    const records=new Map(stock?[]:[['orders/o',{items:[item]}]]), writes=[];
    const line={...item,qty:1,unitPrice:0,orderId:'o',orderItemIndex:0};
    if(stock){delete line.orderId;line.fulfillmentType='WAREHOUSE';line.warehouseId='W';}
    const po={poNo:'PO1',vendorName:'Vendor',buyerName:'Buyer',poDate:'2026-10-16',createdAt:'2026-10-16T00:00:00.000Z',items:[line]};
    const ref=(name,id)=>({id,key:`${name}/${id}`});
    const demandFor=(o,i)=>core.normalizeDemand({sourceType:'SALES_ORDER',sourceId:'o',sourceItemId:i.itemId,requestedQty:i.qty,orderedQty:i.supplyOrderedQty});
    const c=vm.createContext({currentUser:{uid:'buyer'},currentUserRole:'purchaser',currentUserName:'Buyer',
        canCreatePurchaseOrderCapability:()=>true,canAccessPage:()=>true,
        db:{collection:name=>({doc:id=>ref(name,id)})},supplyOrdersCollection:()=>({doc:id=>ref('supplyOrders',id)}),
        formalSupplyOrderId:(id,index)=>`${id}-${index}`,normalizedOrderItems:o=>o.items.map(i=>({...i})),
        normalizedOrderStatus:o=>o.status||'normal',orderInventorySyncIncomplete:()=>false,
        remainingProcurementQty:(o,i)=>demandFor(o,i).remainingToOrderQty,
        procurementDemandForOrderItem:demandFor,YushinProcurementDemand:core,
        procurementDemandRef:id=>ref('procurementDemands',id),procurementDemandDocument:(d,meta)=>({...d,...meta}),
        poIncomingKey:i=>i.productId||'',inventoryProductKey:i=>i.productId||'',resolveBrandName:x=>x,brandIdForName:()=>'',
        defaultWarehouse:()=>({id:'W'}),orderWorkIndexFields:()=>({}),normalizeDocumentLinks:x=>x,
        documentLink:(type,id,rel)=>({type,id,rel}),DOCUMENT_TYPES:{PURCHASE_ORDER:'PURCHASE_ORDER'},
        async runRoleTransaction(callback){
            for(let attempt=0;attempt<(retry?2:1);attempt++) {
                const pending=[];let startedWriting=false;
                await callback({get:async r=>{
                    assert.equal(startedWriting,false,'all reads must precede writes');
                    if(changeAtRead)c.currentUser={uid:'other'};
                    return {id:r.id,exists:records.has(r.key),data:()=>structuredClone(records.get(r.key))};
                },set:(r,data,options)=>{startedWriting=true;pending.push([r.key,data,options?.merge]);},
                update:(r,data)=>{startedWriting=true;pending.push([r.key,data,true]);}});
                if(retry&&attempt===0)continue;
                if(fail)throw new Error('commit failed');
                pending.forEach(([key,data,merge])=>{records.set(key,structuredClone(merge?{...records.get(key),...data}:data));writes.push(key);});
            }
        }
    });
    vm.runInContext(validator+service,c);
    return {c,records,writes,po};
}
test('formal service accumulates split lines into one demand and source order atomically',async()=>{
    const x=setup({retry:true});x.po.items.push({...x.po.items[0],qty:2});
    const result=await x.c.commitFormalPurchaseOrder(x.po);
    assert.equal(x.records.get('procurementDemands/SALES_ORDER:o:i').orderedQty,3);
    assert.equal(x.records.get('orders/o').items[0].supplyOrderedQty,3);
    assert.equal(x.records.get('orders/o').items[0].orderEvents.length,1);
    assert.equal(x.writes.filter(key=>key==='procurementDemands/SALES_ORDER:o:i').length,1,'one final write per shared demand');
    assert.equal(result.committedSourceOrders.length,1);assert.equal(result.committedSupplyOrders.length,2);
    assert.equal(result.committedSupplyOrders[0].unitCost,0);
    assert.equal(x.po.supplyOrderIds,undefined,'caller input remains unmodified until successful return');
    assert.deepEqual([...result.poRecord.supplyOrderIds],['PO1-0','PO1-1']);
    assert.equal(x.writes.some(key=>key.startsWith('inventory/')),false,'incoming remains separate checkpoint');
});
test('formal response-loss replay returns existing records without repeating commitments',async()=>{
    const x=setup();await x.c.commitFormalPurchaseOrder(x.po);const count=x.writes.length;
    const result=await x.c.commitFormalPurchaseOrder({...x.po,createdAt:'2026-10-17T00:00:00Z',lastOutputAt:'later'});
    assert.equal(x.writes.length,count);assert.equal(result.committedSupplyOrders.length,1);
    assert.equal(x.records.get('orders/o').items[0].supplyOrderedQty,1);
});
test('formal existing PO rejects changed content missing supplies and wrong actor',async()=>{
    for(const mutation of ['qty','vendor','missing','actor','links','supplyQty']) {
        const x=setup();await x.c.commitFormalPurchaseOrder(x.po);const count=x.writes.length;
        if(mutation==='qty')x.po.items[0].qty=2;
        if(mutation==='vendor')x.po.vendorName='Other';
        if(mutation==='missing')x.records.delete('supplyOrders/PO1-0');
        if(mutation==='actor')x.c.currentUser={uid:'other'};
        if(mutation==='links')x.records.get('purchaseOrders/PO1').supplyOrderIds=[];
        if(mutation==='supplyQty')x.records.get('supplyOrders/PO1-0').qty=9;
        await assert.rejects(x.c.commitFormalPurchaseOrder(x.po));assert.equal(x.writes.length,count);
    }
});
test('formal replay does not reopen a cancelled PO or overwrite receipt progress',async()=>{
    const x=setup();await x.c.commitFormalPurchaseOrder(x.po);const count=x.writes.length;
    x.records.get('purchaseOrders/PO1').status='CANCELLED';
    Object.assign(x.records.get('supplyOrders/PO1-0'),{status:'RECEIVED',receivedQty:1});
    const result=await x.c.commitFormalPurchaseOrder(x.po);
    assert.equal(result.poRecord.status,'CANCELLED');assert.equal(result.committedSupplyOrders[0].receivedQty,1);
    assert.equal(x.writes.length,count);
});
test('formal service rejects identity switch during reads and original-role mismatch',async()=>{
    const x=setup({changeAtRead:true});await assert.rejects(x.c.commitFormalPurchaseOrder(x.po),/登入身份/);assert.equal(x.writes.length,0);
    const y=setup();y.c.currentUserRole='admin';
    await assert.rejects(y.c.commitFormalPurchaseOrder(y.po,{actorUid:'buyer',actorRole:'purchaser'}),/登入身份/);
    assert.equal(y.writes.length,0);
});
test('formal failed transaction has no partial PO supply demand or source writes',async()=>{
    const x=setup({fail:true});await assert.rejects(x.c.commitFormalPurchaseOrder(x.po),/commit failed/);
    assert.equal(x.records.size,1);assert.equal(x.records.get('orders/o').items[0].supplyOrderedQty,0);
    assert.equal(x.po.supplyOrderIds,undefined);
});
test('formal service rejects oversubscription cancelled source and stale item identity',async()=>{
    for(const mutation of ['qty','cancel','item']) {
        const x=setup();
        if(mutation==='qty')x.po.items[0].qty=4;
        if(mutation==='cancel')x.records.get('orders/o').status='cancelled';
        if(mutation==='item')x.records.get('orders/o').items[0].itemId='different';
        await assert.rejects(x.c.commitFormalPurchaseOrder(x.po));assert.equal(x.writes.length,0);
    }
});
test('independent manual stock PO lines get unique demand IDs and replay the same identity',async()=>{
    const x=setup({stock:true});
    x.po.items.push({...x.po.items[0],qty:2});
    const result=await x.c.commitFormalPurchaseOrder(x.po);
    assert.equal(result.committedSourceOrders.length,0);
    assert.equal(result.committedSupplyOrders[0].warehouseId,'W');
    assert.equal(result.committedSupplyOrders[0].sourceId,'MANUAL_PO:PO1:0');
    assert.equal(result.committedSupplyOrders[1].sourceId,'MANUAL_PO:PO1:1');
    assert.ok(x.records.has('procurementDemands/STOCK_REPLENISHMENT:MANUAL_PO:PO1:0'));
    assert.ok(x.records.has('procurementDemands/STOCK_REPLENISHMENT:MANUAL_PO:PO1:1'));
    const count=x.writes.length;
    await x.c.commitFormalPurchaseOrder(x.po);
    assert.equal(x.writes.length,count,'replay must not duplicate commitments');
});
test('same stock replenishment demand across different POs cannot be overcommitted by stale form',async()=>{
    const x=setup({stock:true}),line=x.po.items[0];
    Object.assign(line,{sourceId:'inventory-I1',demandId:'STOCK_REPLENISHMENT:inventory-I1',demandRequestedQty:2,demandOrderedQty:0});
    await x.c.commitFormalPurchaseOrder(x.po);
    assert.equal(x.records.get('procurementDemands/STOCK_REPLENISHMENT:inventory-I1').orderedQty,1);
    const second={...structuredClone(x.po),poNo:'PO2',items:[{...line,qty:1}]};
    await x.c.commitFormalPurchaseOrder(second);
    const demand=x.records.get('procurementDemands/STOCK_REPLENISHMENT:inventory-I1');
    assert.equal(demand.orderedQty,2);
    assert.equal(demand.remainingToOrderQty,0);
    const count=x.writes.length;
    await assert.rejects(x.c.commitFormalPurchaseOrder({...second,poNo:'PO3'}),/採購需求數量已變更/);
    assert.equal(x.records.has('purchaseOrders/PO3'),false);
    assert.equal(x.writes.length,count);
});
test('stock replenishment rejects reused cancelled or unrelated demand identities without writes',async()=>{
    for(const mutation of ['id','product','cancel','invalid']) {
        const x=setup({stock:true});const line=x.po.items[0];
        Object.assign(line,{sourceId:'I',demandId:'STOCK_REPLENISHMENT:I',demandRequestedQty:2});
        if(mutation==='id')line.demandId='STOCK_REPLENISHMENT:other';
        if(mutation==='invalid')line.demandRequestedQty=Infinity;
        if(mutation==='product'||mutation==='cancel'){
            x.records.set('procurementDemands/STOCK_REPLENISHMENT:I',{
                demandId:'STOCK_REPLENISHMENT:I',sourceType:'STOCK_REPLENISHMENT',sourceId:'I',sourceItemId:'',
                productKey:mutation==='product'?'other':'p',requestedQty:2,orderedQty:0,receivedQty:0,
                status:mutation==='cancel'?'CANCELLED':'PENDING'
            });
        }
        await assert.rejects(x.c.commitFormalPurchaseOrder(x.po));
        assert.equal(x.writes.length,0);
    }
});
test('simultaneous POs for one stock demand conflict and retry on current committed quantity',async()=>{
    const x=setup({stock:true});
    Object.assign(x.po.items[0],{sourceId:'I1',demandId:'STOCK_REPLENISHMENT:I1',demandRequestedQty:1});
    let arrival=0,release;
    const bothPrepared=new Promise(resolve=>{release=resolve});
    // The mock transaction simulates Firestore optimistic conflict detection,
    // including a retry when another PO updated a read document.
    x.c.runRoleTransaction=async callback=>{
        for(let attempt=0;attempt<3;attempt++){
            const reads=new Map(),pending=[];let writing=false;
            await callback({
                get:async ref=>{
                    assert.equal(writing,false,'transaction must read before writing');
                    const data=structuredClone(x.records.get(ref.key));
                    reads.set(ref.key,JSON.stringify(data));
                    return {id:ref.id,exists:data!==undefined,data:()=>structuredClone(data)};
                },
                set:(ref,data,opts)=>{writing=true;pending.push([ref.key,data,opts?.merge]);},
                update:(ref,data)=>{writing=true;pending.push([ref.key,data,true]);}
            });
            if(attempt===0){arrival++;if(arrival===2)release();await bothPrepared;}
            if([...reads].some(([key,before])=>before!==JSON.stringify(x.records.get(key))))continue;
            for(const [key,data,merge] of pending){
                x.records.set(key,structuredClone(merge?{...x.records.get(key),...data}:data));
                x.writes.push(key);
            }
            return;
        }
        throw new Error('transaction conflict');
    };
    const a=structuredClone(x.po),b={...structuredClone(x.po),poNo:'PO2'};
    const results=await Promise.allSettled([x.c.commitFormalPurchaseOrder(a),x.c.commitFormalPurchaseOrder(b)]);
    assert.equal(results.filter(row=>row.status==='fulfilled').length,1);
    assert.equal(results.filter(row=>row.status==='rejected').length,1);
    assert.equal(x.records.get('procurementDemands/STOCK_REPLENISHMENT:I1').orderedQty,1);
    assert.equal(x.writes.filter(key=>key.startsWith('purchaseOrders/')).length,1);
});
test('explicit repeated stock replenishment source within one PO is rejected',async()=>{
    const x=setup({stock:true});
    Object.assign(x.po.items[0],{sourceId:'I1',demandId:'STOCK_REPLENISHMENT:I1',demandRequestedQty:2});
    x.po.items.push({...x.po.items[0]});
    await assert.rejects(x.c.commitFormalPurchaseOrder(x.po),/合併為單一採購列/);
    assert.equal(x.records.size,0);
});
test('formal boundary rejects invalid cost quantity and missing permission',async()=>{
    for(const patch of [{qty:0},{qty:-1},{qty:NaN},{unitPrice:null},{unitPrice:-1},{unitPrice:NaN}]) {
        const x=setup();Object.assign(x.po.items[0],patch);await assert.rejects(x.c.commitFormalPurchaseOrder(x.po));assert.equal(x.writes.length,0);
    }
    const x=setup();x.c.canCreatePurchaseOrderCapability=()=>false;
    await assert.rejects(x.c.commitFormalPurchaseOrder(x.po),/無採購作業權限/);
});
