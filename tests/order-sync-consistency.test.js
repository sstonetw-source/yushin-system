const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('app.js','utf8');
const section=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
const inventory=require('../modules/inventory-core'),workflow=require('../modules/workflow-core');
const demand=require('../modules/procurement-demand-core'),fulfillment=require('../modules/fulfillment-core');

function fixture({items=[{itemId:'I',productId:'P',warehouseId:'W',qty:5}],onHand=10}={}){
 const clone=x=>x===undefined?undefined:structuredClone(x);
 const docs=new Map([
  ['orders/O',{id:'O',ownerUid:'U',salesCode:'S',status:'active',inventoryReservationStatus:'pending',createdAt:'2026-10-14',items:clone(items)}],
  ['inventory/P',{productKey:'P',onHand,reserved:0,incoming:0}],
  ['warehouseStocks/W__P',{productKey:'P',warehouseId:'W',onHand,reserved:0,incoming:0}]
 ]);
 let seq=0;const versions=new Map(),ref=path=>({path,id:path.split('/').at(-1),get:async()=>snap(path)});
 const snap=path=>({exists:docs.has(path),data:()=>clone(docs.get(path)),id:path.split('/').at(-1)});
 const put=(path,data)=>{docs.set(path,clone(data));versions.set(path,(versions.get(path)||0)+1);};
 const db={collection:name=>({doc:id=>ref(name+'/'+(id||'E'+(++seq)))})};
 const controls={beforeCommit:null,fail:false,selfCalls:0};
 const run=async fn=>{
  for(let retry=0;retry<10;retry++){
   const reads=new Map(),writes=[];
   const result=await fn({get:async r=>{assert.equal(writes.length,0,'read before write');reads.set(r.path,versions.get(r.path)||0);return snap(r.path);},
    update:(r,p)=>writes.push([r,p]),set:(r,p)=>writes.push([r,p])});
   if(controls.beforeCommit){const hook=controls.beforeCommit;controls.beforeCommit=null;hook();}
   if([...reads].some(([path,v])=>(versions.get(path)||0)!==v))continue;
   if(controls.fail)throw Error('permission-denied');
   for(const [r,p] of writes)put(r.path,{...docs.get(r.path),...clone(p)});
   return result;
  }
  throw Error('retry exhausted');
 };
 const c=vm.createContext({db,currentUser:{uid:'U'},currentUserName:'Staff',currentUserCode:'S',
  YushinInventory:inventory,YushinWorkflow:workflow,YushinProcurementDemand:demand,YushinFulfillment:fulfillment,
  YushinReservation:require('../modules/reservation-core'),normalizedOrderItems:o=>o.items.map((i,n)=>fulfillment.normalizeItem({...i,
   deliveredQty:o.deliveryRecords?o.deliveryRecords.filter(r=>r.itemId===i.itemId).reduce((s,r)=>s+r.qty,0):i.deliveredQty,
   returnedQty:o.returnRecords?o.returnRecords.filter(r=>r.itemId===i.itemId&&r.settlement!=='CLOSE').reduce((s,r)=>s+r.qty,0):i.returnedQty},n)),
  normalizedOrderStatus:o=>[o.status,o.orderStatus].some(s=>['cancelled','voided'].includes(s))?'cancelled':'normal',
  inventoryNumbers:inventory.normalizeStock,inventoryProductKey:i=>i.productId||'',inventoryRefFor:i=>ref('inventory/'+i.productId),
  warehouseStockDocId:(w,p)=>w+'__'+p,defaultWarehouse:()=>({id:'W'}),inventoryMovementRecord:(type,qty,orderId,productKey,actor,extra)=>({type,qty,sourceId:orderId,productKey,...extra}),
  orderWorkIndexFields:()=>({workCategories:['procurement']}),salesCodeForName:()=> 'S',runRoleTransaction:run,firestoreReadWithTimeout:p=>p,
  warehouseMasterCache:[{id:'W'}],invalidateWarehouseStockCache(){},invalidateProcurementDemandQueue(){},
  registerInitialSelfOrders:async()=>{controls.selfCalls++;}});
 vm.runInContext(section('function procurementDemandForOrderItem(', 'function purchasingLifecycleSnapshot('),c);
 vm.runInContext(section('async function reserveSingleOrderItem(', 'function normalizedOrderItems('),c);
 const sync=()=>c.reserveInventoryForNewOrder('O',clone(docs.get('orders/O')));
 return {c,docs,put,controls,sync,order:()=>docs.get('orders/O'),demand:itemId=>docs.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:'+itemId))};
}

test('stock, item and demand publish atomically; retry never repeats reserved quantity',async()=>{
 const f=fixture({onHand:3});await f.sync();assert.equal(f.order().items[0].reservedQty,3);assert.equal(f.demand('I').remainingToOrderQty,2);
 await f.sync();assert.equal(f.docs.get('inventory/P').reserved,3);assert.equal(f.order().items[0].shortageQty,2);
 assert.equal([...f.docs.values()].filter(x=>x.type==='reserve').length,1);
});
test('failed item transaction leaves stock, reservation, order and demand untouched',async()=>{
 const f=fixture();f.controls.fail=true;const before=JSON.stringify([...f.docs]);
 await assert.rejects(f.sync(),/permission-denied/);assert.equal(JSON.stringify([...f.docs]),before);assert.equal(f.controls.selfCalls,0);
});
test('simultaneous retries and repeated same-product lines do not overwrite or overreserve',async()=>{
 const f=fixture({onHand:6,items:[{itemId:'I',productId:'P',warehouseId:'W',qty:5},{itemId:'J',productId:'P',warehouseId:'W',qty:5}]});
 await Promise.all([f.sync(),f.sync()]);
 assert.deepEqual(f.order().items.map(x=>x.reservedQty),[5,1]);assert.equal(f.docs.get('inventory/P').reserved,6);
 assert.equal(f.demand('J').remainingToOrderQty,4);
});
test('transaction retries use latest supplier commitment and preserve another item and commercial edits',async()=>{
 const f=fixture({items:[{itemId:'I',productId:'P',warehouseId:'W',qty:5},{itemId:'J',productId:'P',warehouseId:'W',qty:1}]});
 f.controls.beforeCommit=()=>{const o=structuredClone(f.order());o.items[0].supplyOrderedQty=3;o.items[0].purchaseOrderNos=['PO-new'];o.items[1].unitPrice=777;o.remarks='new notes';f.put('orders/O',o);};
 await f.sync();assert.equal(f.order().items[0].reservedQty,2);assert.equal(f.demand('I').orderedQty,3);
 assert.equal(f.order().items[0].purchaseOrderNos[0],'PO-new');assert.equal(f.order().items[1].unitPrice,777);assert.equal(f.order().remarks,'new notes');
});
test('cancelled or voided source rejects reservation including cancellation during transaction retry',async()=>{
 for(const field of ['status','orderStatus']){
  const f=fixture();f.controls.beforeCommit=()=>f.put('orders/O',{...f.order(),[field]:'cancelled'});
  await assert.rejects(f.sync(),/取消／作廢/);assert.equal(f.docs.get('inventory/P').reserved,0);assert.equal(f.docs.has('inventoryReservations/O__I'),false);
 }
});
test('already completed source is never reserved again by a delayed initialization',async()=>{
 const f=fixture();f.put('orders/O',{...f.order(),inventoryReservationStatus:'completed',items:[{...f.order().items[0],deliveredQty:5,reservedQty:0}]});
 await f.sync();assert.equal(f.docs.get('inventory/P').reserved,0);assert.equal(f.docs.has('inventoryReservations/O__I'),false);
});
test('old demand disappears from pending purchasing after stock coverage while its date is retained',async()=>{
 const f=fixture();f.put('procurementDemands/SALES_ORDER%3AO%3AI',demand.demandDocument({...demand.fromSalesOrder({sourceId:'O',sourceItemId:'I',shortageQty:5}),scheduleDate:'2026-11-01',createdAt:'old'}));
 await f.sync();assert.equal(f.demand('I').remainingToOrderQty,0);assert.equal(f.demand('I').requestedQty,0);assert.equal(f.demand('I').scheduleDate,'2026-11-01');assert.equal(f.demand('I').createdAt,'old');
});
test('demand lifecycle uses current cancellation and supplier facts instead of caller snapshot',async()=>{
 const f=fixture({onHand:0});await f.sync();const stale=structuredClone(f.order());
 const live=structuredClone(f.order());live.items[0].supplyOrderedQty=3;live.items[0].receivedQty=1;live.status='cancelled';f.put('orders/O',live);
 f.put('procurementDemands/SALES_ORDER%3AO%3AI',{...f.demand('I'),orderedQty:3,receivedQty:1});
 await f.c.syncOrderProcurementDemandLifecycle('O',stale,'normal');
 assert.equal(f.demand('I').status,'CANCELLED');assert.equal(f.demand('I').orderedQty,3);assert.equal(f.demand('I').receivedQty,1);assert.equal(f.demand('I').remainingToOrderQty,0);
});
test('stale cancellation cannot cancel a restored live order demand',async()=>{
 const f=fixture({onHand:0});await f.sync();const stale={...structuredClone(f.order()),status:'cancelled'};
 await f.c.syncOrderProcurementDemandLifecycle('O',stale,'cancelled');assert.equal(f.demand('I').status,'PENDING');assert.equal(f.demand('I').remainingToOrderQty,5);
});
test('historical supplier mismatch fails without erasing demand or committing reservation',async()=>{
 const f=fixture();f.put('procurementDemands/SALES_ORDER%3AO%3AI',demand.demandDocument(demand.fromSalesOrder({sourceId:'O',sourceItemId:'I',shortageQty:5,supplyOrderedQty:3,receivedQty:1})));
 const before=JSON.stringify([...f.docs]);await assert.rejects(f.sync(),/供應進度不一致/);assert.equal(JSON.stringify([...f.docs]),before);
});
test('direct initialization shares demand projection but never creates physical stock or reservation',async()=>{
 const f=fixture({items:[{itemId:'I',productId:'P',qty:3,fulfillmentType:'DIRECT_SHIP'}]});f.docs.delete('inventory/P');f.docs.delete('warehouseStocks/W__P');
 await f.sync();assert.equal(f.demand('I').remainingToOrderQty,3);assert.equal(f.order().items[0].warehouseId,'');assert.equal([...f.docs.keys()].some(k=>/^(inventory|warehouseStocks|inventoryReservations)\//.test(k)),false);
});
test('missing aggregate cannot reserve from warehouse only; total stock bounds allocation',async()=>{
 for(const total of [null,2]){
  const f=fixture();if(total===null)f.docs.delete('inventory/P');else f.put('inventory/P',{onHand:total,reserved:0});
  await f.sync();assert.equal(f.order().items[0].reservedQty,total||0);assert.equal(f.demand('I').remainingToOrderQty,5-(total||0));
 }
});
test('moving one reservation releases its previous location before reserving a new one',async()=>{
 const f=fixture({items:[{itemId:'I',productId:'P',warehouseId:'W2',qty:4}]});
 f.put('inventory/P',{onHand:15,reserved:4});f.put('warehouseStocks/W__P',{onHand:5,reserved:4});
 f.put('warehouseStocks/W2__P',{onHand:10,reserved:0});
 f.put('inventoryReservations/O__I',{orderId:'O',itemId:'I',productKey:'P',warehouseId:'W',quantity:4});
 await f.sync();assert.equal(f.docs.get('inventory/P').reserved,4);assert.equal(f.docs.get('warehouseStocks/W__P').reserved,0);
 assert.equal(f.docs.get('warehouseStocks/W2__P').reserved,4);assert.equal(f.docs.get('inventoryReservations/O__I').warehouseId,'W2');
});
test('missing product publishes an explicit error without inventing physical inventory',async()=>{
 const f=fixture({items:[{itemId:'I',qty:3}]});await f.sync();assert.equal(f.order().items[0].reservationError,'missing_product_master');
 assert.equal([...f.docs.keys()].some(k=>k.startsWith('inventoryReservations/')),false);assert.equal(f.demand('I').remainingToOrderQty,3);
});
