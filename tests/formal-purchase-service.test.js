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
function emulatorSetup(){
 const x=setup(),calls=[];
 Object.assign(x.po,{company:'yushin',supplierName:'Vendor',supplierSnapshot:{supplierId:'',supplierName:'Vendor',purchaseHeaderName:'Vendor',email:'',leadTimeDays:0}});
 x.po.items[0].fulfillmentType='WAREHOUSE';
 const options={projectId:'demo-yushin'};
 const auth={app:{options},emulatorConfig:{host:'127.0.0.1',port:9099},currentUser:{uid:'buyer'}};
 const functions={app:{options},useEmulator:(host,port)=>calls.push({emulator:[host,port]}),
  httpsCallable:name=>async request=>{calls.push({name,request});
   return {data:{status:'committed',poNo:'PO1',supplyOrderIds:['PO1-0']}};}};
 x.records.set('purchaseOrders/PO1',{...x.po,buyerName:'Server Buyer'});
 x.records.set('supplyOrders/PO1-0',{purchaseDocumentId:'PO1',qty:1,unitCost:0});
 x.c.YUSHIN_FORMAL_PURCHASE_EMULATOR=true;x.c.APP_ENVIRONMENT='emulator';x.c.location={hostname:'localhost'};
 x.c.firebase={auth:()=>auth,functions:()=>functions,app:()=>({functions:()=>functions})};
 x.c.db={collection:name=>({doc:id=>({get:async()=>({exists:x.records.has(name+'/'+id),data:()=>structuredClone(x.records.get(name+'/'+id))})})})};
 return {...x,auth,functions,calls};
}
test('formal PO original Service calls scoped backend and re-reads authoritative records without legacy writes',async()=>{
 const x=emulatorSetup(),result=await x.c.commitFormalPurchaseOrder(x.po);
 assert.equal(result.poRecord.buyerName,'Server Buyer');assert.equal(result.committedSourceOrders.length,1);
 assert.equal(result.committedSupplyOrders.length,1);assert.equal(x.writes.length,0);
 const request=x.calls.find(row=>row.name).request;
 assert.equal(request.actorUid,undefined);assert.equal(request.actorRole,undefined);
 assert.equal(request.document.company,'yushin');assert.equal(request.items[0].unitCost,0);
});
test('formal backend gate refuses remote project, wrong Auth or switched real account without fallback',async()=>{
 for(const mutate of [x=>x.c.APP_ENVIRONMENT='production',x=>x.c.location.hostname='example.com',
  x=>x.auth.app.options.projectId='production',x=>x.auth.emulatorConfig.port=1234,x=>x.auth.currentUser.uid='other']){
  const x=emulatorSetup();mutate(x);await assert.rejects(x.c.commitFormalPurchaseOrder(x.po));
  assert.equal(x.writes.length,0);assert.equal(x.calls.some(row=>row.name),false);
 }
});
test('formal backend unknown reply and account changes never fall back to client transaction',async()=>{
 for(const change of [false,true]){
  const x=emulatorSetup();x.functions.httpsCallable=()=>async()=>{
   if(change){x.auth.currentUser.uid='other';return {data:{status:'committed',poNo:'PO1',supplyOrderIds:['PO1-0']}};}
   throw Error('reply lost');
  };
  await assert.rejects(x.c.commitFormalPurchaseOrder(x.po));assert.equal(x.writes.length,0);
 }
});
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

function recoverySetup() {
 const x=emulatorSetup(),storage=new Map(),incoming=new Set(),feedback=[];
 Object.assign(x.c,{
  sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
  document:{getElementById:()=>null},poSaveInProgress:false,poEditingId:null,poIncomingSyncPending:true,
  poListCache:[],supplyReceivingCache:[],invalidateProcurementDemandQueue:()=>{},
  syncCommittedPurchaseOrderSources:()=>{},invalidateWarehouseStockCache:()=>{},
  registerPurchaseIncoming:async id=>incoming.add(id),renderPurchasingView:()=>{},
  showActionFeedback:(message,type)=>feedback.push({message,type}),window:{}
 });
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/features/purchasing/formal-purchase-recovery.js'),'utf8'),x.c);
 return {...x,storage,incoming,feedback};
}
test('formal pending checkpoint freezes original intent across reload and resumes the same Service without another writer',async()=>{
 const x=recoverySetup();x.c.rememberFormalPurchase(x.po,'buyer','purchaser');
 const raw=[...x.storage.values()][0];x.po.items[0].qty=99;
 assert.equal(x.c.pendingFormalPurchase().poRecord.items[0].qty,1);
 // Re-evaluate the browser feature as a new page using the same session data.
 const reloaded=recoverySetup();for(const entry of x.storage)reloaded.storage.set(...entry);
 await reloaded.c.recoverFormalPurchase();
 assert.equal(reloaded.calls.find(row=>row.name).request.items[0].qty,1);
 assert.equal(reloaded.storage.size,0);assert.equal(reloaded.incoming.size,1);
 assert.equal(reloaded.c.poListCache[0].buyerName,'Server Buyer');
 assert.equal(reloaded.c.supplyReceivingCache.length,1);assert.equal(reloaded.writes.length,0);
 await reloaded.c.recoverFormalPurchase();assert.equal(reloaded.calls.filter(row=>row.name).length,1);
 assert.ok(raw.includes('PO1'));
});
test('formal unknown reply and incoming failure retain the exact checkpoint and block a new intent until recovered',async()=>{
 for(const stage of ['callable','incoming']){
  const x=recoverySetup();x.c.rememberFormalPurchase(x.po,'buyer','purchaser');const before=[...x.storage.values()][0];
  const transport=x.functions.httpsCallable;
  if(stage==='callable')x.functions.httpsCallable=()=>async()=>{throw Error('reply lost');};
  else x.c.registerPurchaseIncoming=async()=>{throw Error('incoming reply lost');};
  await x.c.recoverFormalPurchase();assert.equal([...x.storage.values()][0],before);
  assert.throws(()=>x.c.rememberFormalPurchase({...x.po,poNo:'OTHER'},'buyer','purchaser'),/前次/);
  x.functions.httpsCallable=transport;x.c.registerPurchaseIncoming=async id=>x.incoming.add(id);
  await x.c.recoverFormalPurchase();assert.equal(x.storage.size,0);assert.equal(x.incoming.size,1);
  assert.equal(x.c.poListCache.length,1);assert.equal(x.c.supplyReceivingCache.length,1);
 }
});
test('formal recovery serializes clicks and account switching cannot clear the original checkpoint or hydrate another session',async()=>{
 const x=recoverySetup();x.c.rememberFormalPurchase(x.po,'buyer','purchaser');const original=[...x.storage.values()][0];
 let finish;x.functions.httpsCallable=()=>()=>new Promise(resolve=>{finish=resolve;});
 const first=x.c.recoverFormalPurchase();await x.c.recoverFormalPurchase();
 x.c.currentUser={uid:'other'};x.auth.currentUser={uid:'other'};
 finish({data:{status:'committed',poNo:'PO1',supplyOrderIds:['PO1-0']}});await first;
 assert.equal([...x.storage.values()][0],original);assert.equal(x.c.poListCache.length,0);
 assert.equal(x.incoming.size,0);assert.equal(x.feedback.length,0);
 x.c.currentUser={uid:'buyer'};x.auth.currentUser={uid:'buyer'};
 assert.equal(x.c.pendingFormalPurchase().poRecord.poNo,'PO1');
});
test('formal corrupt checkpoint, changed role, unsupported input or unavailable storage fail closed before submission',async()=>{
 const x=recoverySetup();x.c.rememberFormalPurchase(x.po,'buyer','purchaser');
 x.c.currentUserRole='admin';assert.throws(()=>x.c.pendingFormalPurchase(),/原帳號及角色/);
 await x.c.recoverFormalPurchase();assert.equal(x.calls.filter(row=>row.name).length,0);assert.equal(x.storage.size,1);
 x.c.currentUserRole='purchaser';x.storage.set(x.c.formalPurchasePendingKey(),'{broken');
 assert.throws(()=>x.c.pendingFormalPurchase(),/前次採購/);await x.c.recoverFormalPurchase();
 assert.equal(x.calls.filter(row=>row.name).length,0);assert.equal(x.storage.size,1);
 x.storage.clear();
 assert.throws(()=>x.c.rememberFormalPurchase({...x.po,items:[{...x.po.items[0],fulfillmentType:'DIRECT_SHIP'}]},'buyer','purchaser'),/1–5/);
 assert.equal(x.storage.size,0);
 x.c.sessionStorage.setItem=()=>{throw Error('storage disabled');};
 assert.throws(()=>x.c.rememberFormalPurchase(x.po,'buyer','purchaser'),/storage disabled/);
 assert.equal(x.calls.filter(row=>row.name).length,0);
});

test('document preparation persists only PO snapshot and replays without supply or demand writes',async()=>{
 const x=setup(),before=structuredClone([...x.records]);
 const doc=await x.c.saveFormalPurchaseDocument(x.po);
 assert.equal(doc.status,'DRAFT');assert.equal(doc.documentOnly,true);
 assert.equal(doc.createdByUid,'buyer');assert.equal(doc.supplyOrderIds,undefined);
 assert.deepEqual(x.writes,['purchaseOrders/PO1']);
 assert.deepEqual([...x.records].filter(([key])=>key!=='purchaseOrders/PO1'),before);
 await x.c.saveFormalPurchaseDocument(x.po);assert.equal(x.writes.length,1);
 await assert.rejects(x.c.saveFormalPurchaseDocument({...x.po,items:[{...x.po.items[0],qty:2}]}),/不同內容/);
});
test('explicit confirmation upgrades original document through existing trade Service once',async()=>{
 const x=setup();const draft=await x.c.saveFormalPurchaseDocument(x.po);
 const result=await x.c.commitFormalPurchaseOrder(draft);
 assert.equal(result.poRecord.status,'ORDERED');assert.equal(result.poRecord.documentOnly,false);
 assert.equal(result.committedSourceOrders[0].items[0].supplyOrderedQty,1);
 assert.equal(result.committedSupplyOrders.length,1);
 const writes=x.writes.length,before=structuredClone([...x.records]);
 await x.c.commitFormalPurchaseOrder(draft);
 assert.equal(x.writes.length,writes);assert.deepEqual([...x.records],before);
 await assert.rejects(x.c.saveFormalPurchaseDocument(x.po),/已確認採購/);
});
test('changed source demand or changed document intent rejects confirmation without trade writes',async()=>{
 for(const change of ['demand','document']){
  const x=setup();const draft=await x.c.saveFormalPurchaseDocument(x.po);
  if(change==='demand')x.records.get('orders/o').items[0].supplyOrderedQty=3;
  else draft.items[0].qty=2;
  const before=structuredClone([...x.records]),count=x.writes.length;
  await assert.rejects(x.c.commitFormalPurchaseOrder(draft));
  assert.equal(x.writes.length,count);assert.deepEqual([...x.records],before);
 }
});
