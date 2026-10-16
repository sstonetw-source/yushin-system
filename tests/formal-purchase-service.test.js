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
test('formal stock purchase has no source order and refuses ambiguous repeated demand',async()=>{
    const x=setup({stock:true});const result=await x.c.commitFormalPurchaseOrder(x.po);
    assert.equal(result.committedSourceOrders.length,0);assert.equal(result.committedSupplyOrders[0].sourceType,'STOCK_REPLENISHMENT');
    assert.equal(result.committedSupplyOrders[0].warehouseId,'W');
    const y=setup({stock:true});y.po.items.push({...y.po.items[0]});
    await assert.rejects(y.c.commitFormalPurchaseOrder(y.po),/合併為單一採購列/);assert.equal(y.records.size,0);
});
test('formal boundary rejects invalid cost quantity and missing permission',async()=>{
    for(const patch of [{qty:0},{qty:-1},{qty:NaN},{unitPrice:null},{unitPrice:-1},{unitPrice:NaN}]) {
        const x=setup();Object.assign(x.po.items[0],patch);await assert.rejects(x.c.commitFormalPurchaseOrder(x.po));assert.equal(x.writes.length,0);
    }
    const x=setup();x.c.canCreatePurchaseOrderCapability=()=>false;
    await assert.rejects(x.c.commitFormalPurchaseOrder(x.po),/無採購作業權限/);
});
