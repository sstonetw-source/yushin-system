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
    vm.runInContext(source,c);
    return {c,records,writes,invalidated,attempts,receive:(qty=2,lot=direct?'':'LOT',expiry=direct?'':'2027-01-01',id='OP',options={})=>c.receiveSupplyOrderRecord('S',qty,lot,expiry,id,{onStockCommitted:c.invalidateWarehouseStockCache,...options})};
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
    const f=setup({replay:true,afterDiscard(c,records,n){if(n!==1)return;const s=records.get('supplyOrders/S');s.fulfillmentType='DIRECT_SHIP';s.warehouseId='';s.incomingRegisteredQty=0;records.get('orders/O').items[0].fulfillmentType='DIRECT_SHIP';}});
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
async function refusesWithoutWrites(f,pattern){
    const before=JSON.stringify([...f.records]);await assert.rejects(f.receive(),pattern);
    assert.equal(JSON.stringify([...f.records]),before);assert.equal(f.writes.length,0);assert.equal(f.invalidated.length,0);
}
test('missing source order, source item and duplicate item IDs cannot silently receive as free stock',async()=>{
    for(const kind of ['order','item','duplicate','itemId','orderId','alias']){
        const f=setup(),s=f.records.get('supplyOrders/S'),o=f.records.get('orders/O');
        if(kind==='order')f.records.delete('orders/O');
        if(kind==='item')o.items[0].itemId='OTHER';
        if(kind==='duplicate')o.items.push({...o.items[0]});
        if(kind==='itemId')delete s.itemId;
        if(kind==='orderId')delete s.orderId;
        if(kind==='alias')s.sourceId='OTHER';
        await refusesWithoutWrites(f,/來源|識別碼/);
    }
});
test('wrong source product, fulfillment mode or incoming warehouse refuses all receipt writes',async()=>{
    for(const kind of ['product','mode','warehouse','transfer']){
        const f=setup(),i=f.records.get('orders/O').items[0];
        if(kind==='product')i.productId='OTHER';
        if(kind==='mode')i.fulfillmentType='DIRECT_SHIP';
        if(kind==='warehouse')i.warehouseId='OTHER';
        if(kind==='transfer')i.transferPendingId='TRANSFER';
        await refusesWithoutWrites(f,/產品|供貨|倉庫/);
    }
});
test('saved supply warehouse is required and never guessed from the default',async()=>{
    const f=setup();delete f.records.get('supplyOrders/S').warehouseId;f.c.defaultWarehouse=()=>({id:'W'});
    await refusesWithoutWrites(f,/尚未指定入庫倉庫/);
});
test('source inventory synchronization must finish before receiving',async()=>{
    const f=setup();f.c.orderInventorySyncIncomplete=()=>true;await refusesWithoutWrites(f,/庫存同步尚未完成/);
});
test('company and warehouse incoming must each cover the exact core receipt release',async()=>{
    for(const path of ['inventory/P','warehouseStocks/W__P']){
        const f=setup();f.records.get(path).incoming=1;await refusesWithoutWrites(f,/在途保留量不足/);
        const g=setup();g.records.delete(path);await refusesWithoutWrites(g,/在途保留量不足/);
    }
});
test('receipt rejects mismatched company and warehouse product or warehouse identity',async()=>{
    for(const [path,field] of [['inventory/P','productKey'],['inventory/P','productId'],['warehouseStocks/W__P','productKey'],['warehouseStocks/W__P','productId'],['warehouseStocks/W__P','warehouseId']]){
        const f=setup();f.records.get(path)[field]='OTHER';await refusesWithoutWrites(f,/庫存識別不符/);
    }
});
test('receipt cannot normalize malformed or negative aggregate stock silently',async()=>{
    for(const path of ['inventory/P','warehouseStocks/W__P'])for(const field of ['onHand','reserved','incoming'])for(const value of [-1,NaN,Infinity,'',null,false]){
        const f=setup();f.records.get(path)[field]=value;await refusesWithoutWrites(f,/數量異常/);
    }
    const f=setup();f.records.get('inventory/P').reserved=1;await refusesWithoutWrites(f,/預留超過實貨/);
});
test('reservation identity and quantities must match the live source item',async()=>{
    for(const [field,value] of [['orderId','OTHER'],['itemId','OTHER'],['productKey','OTHER'],['warehouseId','OTHER'],['quantity',1],['shortageQty',4],['quantity',-1],['quantity',NaN]]){
        const f=setup();f.records.get('inventoryReservations/O__I')[field]=value;await refusesWithoutWrites(f,/來源|數量異常/);
    }
    const f=setup();f.records.delete('inventoryReservations/O__I');await refusesWithoutWrites(f,/缺少庫存預留/);
});
test('aggregate reserved must cover the existing source reservation before adding a receipt',async()=>{
    for(const path of ['inventory/P','warehouseStocks/W__P']){
        const f=setup();f.records.get('orders/O').items[0].reservedQty=1;
        Object.assign(f.records.get('inventoryReservations/O__I'),{quantity:1,shortageQty:4});
        for(const p of ['inventory/P','warehouseStocks/W__P'])Object.assign(f.records.get(p),{onHand:1,reserved:1});
        f.records.get(path).reserved=0;await refusesWithoutWrites(f,/預留數量不一致/);
    }
});
test('source commitment and malformed supply incoming cannot be hidden by normalization',async()=>{
    for(const kind of ['sourceQty','sourceReceived','sourceNegative','registeredNegative','registeredExcess','registeredNull']){
        const f=setup(),s=f.records.get('supplyOrders/S'),i=f.records.get('orders/O').items[0];
        if(kind==='sourceQty')i.supplyOrderedQty=1;
        if(kind==='sourceReceived')i.receivedQty=4;
        if(kind==='sourceNegative')i.receivedQty=-1;
        if(kind==='registeredNegative')s.incomingRegisteredQty=-1;
        if(kind==='registeredExcess')s.incomingRegisteredQty=6;
        if(kind==='registeredNull')s.incomingRegisteredQty=null;
        await refusesWithoutWrites(f,/數量|承諾量不足/);
    }
});
test('existing procurement demand must match source and have enough valid outstanding commitment',async()=>{
    for(const [field,value] of [['sourceId','OTHER'],['sourceItemId','OTHER'],['productKey','OTHER'],['fulfillmentType','DIRECT_SHIP'],['orderedQty',1],['receivedQty',4],['receivedQty',-1],['orderedQty',null]]){
        const f=setup();f.records.get('procurementDemands/D')[field]=value;await refusesWithoutWrites(f,/需求.*不符|承諾量不足|數量異常/);
    }
});
test('separate partial receipts consume incoming exactly and retries never repeat release',async()=>{
    const f=setup();await f.receive();await f.receive(2,'LOT','2027-01-01','OP2');await f.receive(2,'LOT','2027-01-01','OP2');
    for(const path of ['inventory/P','warehouseStocks/W__P']){
        const s=f.records.get(path);assert.deepEqual([s.onHand,s.reserved,s.incoming],[4,4,1]);
    }
    assert.equal(f.records.get('supplyOrders/S').receivedQty,4);assert.equal(f.records.get('supplyOrders/S').incomingRegisteredQty,1);
    assert.equal(f.records.get('procurementDemands/D').receivedQty,4);
});
test('unregistered legacy incoming may receive with zero release but never fabricates incoming',async()=>{
    const f=setup();f.records.get('supplyOrders/S').incomingRegisteredQty=0;
    f.records.delete('inventory/P');f.records.delete('warehouseStocks/W__P');await f.receive();
    assert.equal(f.records.get('inventory/P').onHand,2);assert.equal(f.records.get('inventory/P').incoming,0);
});
test('standalone replenishment still receives without a fabricated customer source',async()=>{
    const f=setup(),s=f.records.get('supplyOrders/S');delete s.orderId;delete s.itemId;s.sourceType='STOCK_REPLENISHMENT';
    f.records.get('procurementDemands/D').sourceId='P';
    await f.receive();assert.equal(f.records.get('orders/O').items[0].receivedQty,0);
    assert.equal(f.records.get('inventory/P').onHand,2);assert.equal(f.records.get('receipts/OP').autoAllocationQty,2);
});
test('committed receipt retry does not revalidate later cancelled source or changed incoming as a new receipt',async()=>{
    const f=setup();await f.receive();f.records.delete('orders/O');f.records.get('inventory/P').incoming=0;
    const before=f.writes.length;await f.receive();assert.equal(f.writes.length,before);assert.equal(f.records.get('inventory/P').onHand,2);
});
test('direct shipment enforces source identity and never releases phantom company incoming',async()=>{
    for(const kind of ['product','mode','incoming','commitment']){
        const f=setup({direct:true});
        if(kind==='product')f.records.get('orders/O').items[0].productId='OTHER';
        if(kind==='mode')f.records.get('orders/O').items[0].fulfillmentType='WAREHOUSE';
        if(kind==='incoming')f.records.get('supplyOrders/S').incomingRegisteredQty=1;
        if(kind==='commitment')f.records.get('orders/O').items[0].supplyOrderedQty=1;
        await refusesWithoutWrites(f,/產品|供貨|在途|承諾/);
    }
});
test('receipt service executes without browser window, document or cache globals',async()=>{
    const f=setup();delete f.c.window;delete f.c.invalidateWarehouseStockCache;
    const ids=await f.receive(2,'LOT','2027-01-01','OP',{onStockCommitted:null});
    assert.deepEqual(Array.from(ids),['O']);assert.equal(f.records.get('inventory/P').onHand,2);assert.equal(f.invalidated.length,0);
});
test('postcommit notification runs once per committed stage, never per discarded callback',async()=>{
    const f=setup({replay:true}),notifications=[];addWaiting(f);
    await f.receive(2,'LOT','2027-01-01','OP',{onStockCommitted:(key,warehouse)=>{
        assert.equal(f.records.has('receipts/OP'),true);
        notifications.push([key,warehouse,f.records.get('inventory/P').reserved]);
    }});
    assert.deepEqual(notifications,[['P','W',0],['P','W',2]]);
    const g=setup({failCommit:1});let called=false;
    await assert.rejects(g.receive(2,'LOT','2027-01-01','OP',{onStockCommitted:()=>{called=true;}}));assert.equal(called,false);
});
test('notification failure after receipt preserves committed result and retries without double stock',async()=>{
    const f=setup();await assert.rejects(f.receive(2,'LOT','2027-01-01','OP',{onStockCommitted:()=>{throw Error('view notification failed');}}),e=>e.receiptCommitted&&/view notification/.test(e.message));
    assert.equal(f.records.get('inventory/P').onHand,2);await f.receive();assert.equal(f.records.get('inventory/P').onHand,2);
});
test('notification failure after allocation preserves checkpoint and retry cannot allocate twice',async()=>{
    const f=setup();addWaiting(f);let stage=0;
    await assert.rejects(f.receive(2,'LOT','2027-01-01','OP',{onStockCommitted:()=>{if(++stage===2)throw Error('view notification failed');}}),e=>e.receiptCommitted);
    assert.equal(f.records.get('receipts/OP').autoAllocatedQty,2);await f.receive();
    assert.equal(f.records.get('inventory/P').onHand,2);assert.equal(f.records.get('inventory/P').reserved,2);
});

test('source receipt adds only at its receiving location and preserves another warehouse holds',async()=>{
 const f=setup();f.records.set('warehouseStocks/OTHER__P',{productKey:'P',warehouseId:'OTHER',onHand:8,reserved:4});
 f.records.set('inventory/P',{productKey:'P',onHand:8,reserved:4,incoming:5});
 const before=structuredClone(f.records.get('warehouseStocks/OTHER__P'));
 await f.receive();await f.receive();
 assert.equal(f.records.get('inventory/P').onHand,10);assert.equal(f.records.get('inventory/P').reserved,6);
 assert.equal(f.records.get('warehouseStocks/W__P').onHand,2);assert.equal(f.records.get('warehouseStocks/W__P').reserved,2);
 assert.deepEqual(f.records.get('warehouseStocks/OTHER__P'),before);
});
test('source receipt rejects corrupt free-transit balances before creating receipt lots or supply progress',async()=>{
 for(const value of [NaN,-1,'bad']){
  const f=setup();f.records.get('inventory/P').transferFreeInTransit=value;const before=structuredClone([...f.records]);
  await assert.rejects(f.receive(),/數量不正確|核對/);assert.deepEqual([...f.records],before);
 }
});

test('direct partial and final arrivals keep physical shortage and reservations at zero',async()=>{
 const f=setup({direct:true});await f.receive(2,'','','direct-first');
 let item=f.records.get('orders/O').items[0];
 assert.equal(item.receivedQty,2);assert.equal(item.deliveredQty,2);assert.equal(item.reservedQty,0);assert.equal(item.shortageQty,0);
 await f.receive(3,'','','direct-final');item=f.records.get('orders/O').items[0];
 assert.equal(item.receivedQty,5);assert.equal(item.deliveredQty,5);assert.equal(item.shortageQty,0);assert.equal(item.reservedQty,0);
});
