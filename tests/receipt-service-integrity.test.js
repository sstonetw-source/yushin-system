const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('src/services/receiving.js','utf8');
const receiving=require('../modules/receiving-core'),supplyCore=require('../modules/supply-core');
const demand=require('../modules/procurement-demand-core'),fulfillment=require('../modules/fulfillment-core');
const inventory=require('../modules/inventory-core'),workflow=require('../modules/workflow-core');
function setup({direct=false,replay=false,afterRead,afterCommit,afterDiscard,failCommit=0}={}){
    const item={itemId:'I',productId:'P',warehouseId:direct?'':'W',qty:5,orderedQty:5,
        supplyOrderedQty:5,receivedQty:0,reservedQty:0,shortageQty:direct?0:5,fulfillmentType:direct?'DIRECT_SHIP':'WAREHOUSE'};
    const records=new Map([
        ['supplyOrders/S',{id:'S',orderId:'O',itemId:'I',ownerUid:'U',productKey:'P',productId:'P',warehouseId:item.warehouseId,
            fulfillmentType:item.fulfillmentType,qty:5,receivedQty:0,incomingRegisteredQty:direct?0:5,status:'ORDERED',demandId:'D',unitCost:10}],
        ['orders/O',{ownerUid:'U',status:'active',items:[item],deliveryRecords:[],returnRecords:[]}],
        ['inventoryReservations/O__I',{orderId:'O',itemId:'I',productKey:'P',warehouseId:'W',quantity:0,shortageQty:5,status:'shortage'}],
        ['inventory/P',{onHand:0,reserved:0,incoming:5}],['warehouseStocks/W__P',{onHand:0,reserved:0,incoming:5}],
        ['procurementDemands/D',demand.normalizeDemand({demandId:'D',requestedQty:5,orderedQty:5,receivedQty:0})]
    ]);
    let sequence=0,commits=0;const writes=[],invalidated=[],attempts=[];
    const snapshot=key=>({exists:records.has(key),id:key.split('/').at(-1),data:()=>structuredClone(records.get(key))});
    const c=vm.createContext({currentUser:{uid:'U'},currentUserRole:direct?'sales':'purchaser',permissionRulesReady:true,
        window:{YushinReceiving:receiving},YushinReceiving:receiving,YushinSupply:supplyCore,YushinProcurementDemand:demand,
        YushinReservation:require('../modules/reservation-core'),
        isPurchaseTerminalStatus:s=>['CANCELLED','CLOSED'].includes(s),deliveryActor:()=> 'Receiver',localDateString:()=> '2026-10-16',
        canConfirmSupplyReceipt:s=>(s.fulfillmentType==='DIRECT_SHIP'
            ?c.currentUserRole==='admin'||(['sales','engineer'].includes(c.currentUserRole)&&s.ownerUid===c.currentUser?.uid)
            :['admin','purchaser','warehouse'].includes(c.currentUserRole)),
        db:{collection(name){const filters=[];return {
            doc:id=>({key:name+'/'+(id||'event-'+ ++sequence),id:id||'event-'+sequence}),
            where(k,op,v){filters.push([k,v]);return this;},limit(){return this;},
            async get(){const rows=[...records].filter(([key,data])=>key.startsWith(name+'/')&&filters.every(([k,v])=>data[k]===v));
                return {docs:rows.map(([key])=>snapshot(key)),size:rows.length};}
        };}},
        supplyOrdersCollection:()=>c.db.collection('supplyOrders'),procurementDemandRef:id=>id?c.db.collection('procurementDemands').doc(id):null,
        procurementDemandDocument:(d,extra,meta)=>demand.demandDocument({...d,...extra},meta),
        normalizedOrderItems:o=>o.items.map(fulfillment.normalizeItem),normalizedOrderStatus:o=>o.status==='cancelled'?'cancelled':'normal',
        orderInventorySyncIncomplete:()=>false,orderWorkIndexFields:()=>({}),inventoryNumbers:inventory.normalizeStock,
        inventoryProductKey:i=>i.productId,warehouseStockDocId:(w,p)=>w+'__'+p,buildInventorySearchTokens:()=>[],
        savedDeliveryRecords:o=>o.deliveryRecords||[],returnedQuantity:()=>0,orderQuantity:o=>o.items.reduce((n,i)=>n+i.qty,0),
        remainingProcurementQty:(o,i)=>workflow.procurementQuantities(i).remainingToOrderQty,
        procurementDemandForOrderItem:(o,i)=>demand.fromSalesOrder({sourceId:o.id,sourceItemId:i.itemId,shortageQty:i.shortageQty,supplyOrderedQty:i.supplyOrderedQty,receivedQty:i.receivedQty}),
        inventoryMovementRecord:(type,qty,id,key,actor,extra)=>({type,qty,sourceId:id,productKey:key,createdBy:actor,...extra}),
        invalidateWarehouseStockCache:(...args)=>invalidated.push(args),firestoreReadWithTimeout:p=>p,
        readQueryInBatches:async query=>(await query.get()).docs.map(s=>s.data()),
        async runRoleTransaction(callback){
            const n=++commits;
            for(let attempt=0;attempt<(replay?2:1);attempt++){
                const pending=[];let writing=false;
                await callback({get:async ref=>{assert.equal(writing,false,'reads before writes');const snap=snapshot(ref.key);await afterRead?.(c,ref.key,n,attempt,records);return snap;},
                    set:(ref,data,opts)=>{writing=true;pending.push([ref.key,data,!!opts?.merge]);},
                    update:(ref,data)=>{writing=true;pending.push([ref.key,data,true]);}});
                attempts.push(structuredClone(pending));
                if(replay&&attempt===0){afterDiscard?.(c,records,n);continue;}
                if(n===failCommit)throw Error('commit failed');
                for(const [key,data,merge] of pending){records.set(key,structuredClone(merge?{...records.get(key),...data}:data));writes.push(key);}
                await afterCommit?.(c,n,records);
            }
        }
    });
    vm.runInContext(source.slice(source.indexOf('async function allocateFreeReceiptStockToShortages('),source.indexOf('async function refreshAffectedOrderCaches(')),c);
    vm.runInContext(source.slice(source.indexOf('async function receiveSupplyOrderRecord('),source.indexOf('window.openSupplyReceipt')),c);
    return {c,records,writes,invalidated,attempts,receive:(qty=2,lot=direct?'':'LOT',expiry=direct?'':'2027-01-01',id='OP',options={})=>c.receiveSupplyOrderRecord('S',qty,lot,expiry,id,options)};
}
test('receipt callback replay and lost-response retry commit stock, lot, cost and history once',async()=>{
    const f=setup({replay:true});await f.receive();
    assert.deepEqual(f.attempts[0],f.attempts[1]);
    const first=f.writes.length;await f.receive();assert.equal(f.writes.length,first);
    assert.equal(f.records.get('inventory/P').onHand,2);assert.equal(f.records.get('warehouseStocks/W__P').reserved,2);
    assert.equal(f.records.get('orders/O').items[0].receiptEvents.length,1);
    for(const name of ['inventoryLots/','inventoryLotCosts/','inventoryMovements/'])assert.equal([...f.records.keys()].filter(k=>k.startsWith(name)).length,1);
    assert.equal(f.records.get('receipts/OP').createdByUid,'U');assert.equal(f.records.get('receipts/OP').createdByRole,'purchaser');
});
test('receipt commit failure preserves all documents',async()=>{
    const f=setup({failCommit:1}),before=JSON.stringify([...f.records]);await assert.rejects(f.receive(),/commit failed/);
    assert.equal(JSON.stringify([...f.records]),before);assert.equal(f.invalidated.length,0);
});
test('same receipt ID refuses different quantity, lot, expiry and original actor',async()=>{
    const f=setup();await f.receive();const before=JSON.stringify([...f.records]);
    for(const args of [[1], [2,'OTHER'],[2,'LOT','2028-01-01']])await assert.rejects(f.receive(...args),/識別碼衝突/);
    f.c.currentUser={uid:'OTHER'};await assert.rejects(f.receive(),/識別碼衝突/);
    f.c.currentUser={uid:'U'};f.c.currentUserRole='admin';await assert.rejects(f.receive(),/識別碼衝突/);
    assert.equal(JSON.stringify([...f.records]),before);
});
test('historical receipt without actor metadata still checks persisted request details',async()=>{
    const f=setup();await f.receive();const r=f.records.get('receipts/OP');delete r.createdByUid;delete r.createdByRole;
    await f.receive();await assert.rejects(f.receive(1),/識別碼衝突/);assert.equal(f.records.get('inventory/P').onHand,2);
});
test('receipt rejects malformed quantities and mismatched captured identity before writes',async()=>{
    for(const qty of [NaN,Infinity,-1,0,'2']){const f=setup();await assert.rejects(f.receive(qty),/有效數字/);assert.equal(f.writes.length,0);}
    for(const options of [{actorUid:'OTHER',actorRole:'purchaser'},{actorUid:'U',actorRole:'admin'}]){
        const f=setup();await assert.rejects(f.receive(2,'LOT','2027-01-01','OP',options),/登入帳號或角色/);assert.equal(f.writes.length,0);
    }
});
test('identity changes during supply, demand or stock reads abort the whole receipt',async()=>{
    for(const key of ['supplyOrders/S','procurementDemands/D','warehouseStocks/W__P','orders/O']){
        const f=setup({afterRead(c,k){if(k===key)c.currentUserRole='admin';}}),before=JSON.stringify([...f.records]);
        await assert.rejects(f.receive(),/登入帳號或角色/);assert.equal(JSON.stringify([...f.records]),before);
    }
});
test('identity change after physical commit preserves receipt and prevents cache updates',async()=>{
    const f=setup({afterCommit(c,n){if(n===1)c.currentUser={uid:'OTHER'};}});
    await assert.rejects(f.receive(),e=>e.receiptCommitted&&e.code==='receipt-allocation-pending');
    assert.equal(f.records.get('inventory/P').onHand,2);assert.equal(f.invalidated.length,0);
    f.c.currentUser={uid:'U'};await f.receive();assert.equal(f.records.get('inventory/P').onHand,2);
});
test('discarded warehouse attempt cannot leak cache or allocation output into direct-ship retry',async()=>{
    const f=setup({replay:true,afterDiscard(c,records,n){if(n!==1)return;const s=records.get('supplyOrders/S');s.fulfillmentType='DIRECT_SHIP';s.warehouseId='';s.incomingRegisteredQty=0;}});
    f.c.currentUserRole='admin';await f.receive(2,'','');assert.equal(f.records.get('inventory/P').onHand,0);
    assert.equal(f.records.get('orders/O').deliveryRecords.length,1);assert.equal(f.invalidated.length,0);
});
test('direct shipment retries never create warehouse stock and identity changes abort source writes',async()=>{
    const f=setup({direct:true,replay:true});await f.receive();await f.receive();
    assert.equal(f.records.get('orders/O').deliveryRecords.length,1);assert.equal(f.records.get('inventory/P').onHand,0);
    assert.equal([...f.records.keys()].some(k=>k.startsWith('inventoryLots/')),false);
    const g=setup({direct:true,afterRead(c,k){if(k==='orders/O')c.currentUser={uid:'OTHER'};}});
    await assert.rejects(g.receive(),/登入帳號或角色/);assert.equal(g.writes.length,0);
});
function addWaiting(f){
    f.records.get('orders/O').status='cancelled';f.records.get('supplyOrders/S').customerCancellationDisposition='KEEP_STOCK';
    const item={itemId:'J',productId:'P',warehouseId:'W',qty:2,orderedQty:2,reservedQty:0,shortageQty:2,supplyOrderedQty:0,receivedQty:0};
    f.records.set('orders/WAIT',{status:'active',items:[item]});
    f.records.set('inventoryReservations/WAIT__J',{orderId:'WAIT',itemId:'J',productKey:'P',warehouseId:'W',quantity:0,shortageQty:2,status:'shortage'});
}
test('receipt allocation preserves receipt movement type with a session guard and resumes once',async()=>{
    const f=setup({replay:true});addWaiting(f);await f.receive();await f.receive();
    assert.equal(f.records.get('receipts/OP').autoAllocatedQty,2);assert.equal(f.records.get('inventory/P').reserved,2);
    const movements=[...f.records].filter(([key])=>key.startsWith('inventoryMovements/')).map(([,v])=>v);
    assert.equal(movements.filter(v=>v.type==='reserve_from_receipt').length,1);assert.equal(movements.some(v=>v.type==='reserve_from_free_stock'),false);
});
test('allocation read identity switch leaves physical stock committed and reservation pending',async()=>{
    let change=true;const f=setup({afterRead(c,key,n){if(change&&n===2&&key==='orders/WAIT')c.currentUserRole='admin';}});addWaiting(f);
    await assert.rejects(f.receive(),e=>e.receiptCommitted);
    assert.equal(f.records.get('inventory/P').onHand,2);assert.equal(f.records.get('inventory/P').reserved,0);
    assert.equal(f.records.get('receipts/OP').autoAllocatedQty,0);change=false;f.c.currentUserRole='purchaser';
    await f.receive();assert.equal(f.records.get('inventory/P').reserved,2);assert.equal(f.records.get('inventory/P').onHand,2);
});
test('postcommit reconciliation failure is reported as committed receipt pending allocation',async()=>{
    const f=setup();addWaiting(f);f.c.allocateFreeReceiptStockToShortages=async()=>{throw Error('allocation failed');};
    await assert.rejects(f.receive(),e=>e.receiptCommitted);
    f.c.readQueryInBatches=async()=>{throw Error('movement query failed');};
    await assert.rejects(f.receive(),e=>e.receiptCommitted&&/movement query/.test(e.message));assert.equal(f.records.get('inventory/P').onHand,2);
});
