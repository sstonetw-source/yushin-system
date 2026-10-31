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
  ['warehouses/W',{active:true,isDefault:true}],
  ['warehouseStocks/W__P',{productKey:'P',warehouseId:'W',onHand,reserved:0,incoming:0}]
 ]);
 let seq=0;const versions=new Map(),ref=path=>({path,id:path.split('/').at(-1),get:async()=>snap(path)});
 const snap=path=>({exists:docs.has(path),data:()=>clone(docs.get(path)),id:path.split('/').at(-1)});
 const put=(path,data)=>{docs.set(path,clone(data));versions.set(path,(versions.get(path)||0)+1);};
 const db={collection:name=>({doc:id=>ref(name+'/'+(id||'E'+(++seq)))})};
 const controls={beforeCommit:null,fail:false,selfCalls:0};
 const run=async fn=>{
  for(let retry=0;retry<10;retry++){
   // Firestore reads one consistent snapshot per attempt; a concurrent commit
   // cannot make the company read old while a later warehouse read sees new.
   const attemptDocs=new Map([...docs].map(([path,data])=>[path,clone(data)])),attemptVersions=new Map(versions);
   const reads=new Map(),writes=[];
   const result=await fn({get:async r=>{assert.equal(writes.length,0,'read before write');reads.set(r.path,attemptVersions.get(r.path)||0);return {exists:attemptDocs.has(r.path),data:()=>clone(attemptDocs.get(r.path)),id:r.id};},
    update:(r,p)=>writes.push([r,p]),set:(r,p)=>writes.push([r,p])});
   if(controls.beforeCommit){const hook=controls.beforeCommit;controls.beforeCommit=null;hook();}
   if([...reads].some(([path,v])=>(versions.get(path)||0)!==v))continue;
   if(controls.fail)throw Error('permission-denied');
   for(const [r,p] of writes){
    const next={...docs.get(r.path),...clone(p)};
    for(const [key,value] of Object.entries(p))if(value?.__arrayUnion)next[key]=[...(docs.get(r.path)?.[key]||[]),...clone(value.__arrayUnion)];
    put(r.path,next);
   }
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
  warehouseMasterCache:[{id:'W'}],warehouseMasterLoadPromise:Promise.resolve(),loadWarehouseMaster:async()=>{},invalidateWarehouseStockCache(){},invalidateProcurementDemandQueue(){},
  registerInitialSelfOrders:async()=>{controls.selfCalls++;}});
 vm.runInContext(section('function procurementDemandForOrderItem(', 'function purchasingLifecycleSnapshot('),c);
 vm.runInContext(fs.readFileSync('src/services/order-reservation.js','utf8'),c);
 const sync=()=>c.reserveInventoryForNewOrder('O',clone(docs.get('orders/O')));
 return {c,docs,put,controls,sync,order:()=>docs.get('orders/O'),demand:itemId=>docs.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:'+itemId))};
}

test('unknown whole-order backend result never resumes legacy stock writing',async()=>{
 const f=fixture();
 f.c.orderReservationBackendEnabled=()=>true;
 f.c.commitNewOrderReservationPreview=async()=>{throw Error('backend unknown receipt');};
 const before=JSON.stringify([...f.docs]);
 await assert.rejects(f.sync(),/backend unknown receipt/);
 assert.equal(JSON.stringify([...f.docs]),before);
 assert.equal(f.controls.selfCalls,0);
});
test('backend flag disabled after route selection cannot masquerade as a completed reservation',async()=>{
 const f=fixture();let checks=0;
 f.c.orderReservationBackendEnabled=()=>++checks===1;
 f.c.commitNewOrderReservationPreview=async()=>false;
 const before=JSON.stringify([...f.docs]);
 await assert.rejects(f.sync(),/尚無提交確認/);
 assert.equal(JSON.stringify([...f.docs]),before);
 assert.equal(f.controls.selfCalls,0);
});
test('initial demand projection fences actor and attempt without changing general lifecycle projection',async()=>{
 const f=fixture({onHand:0});f.put('orders/O',{...f.order(),inventoryReservationAttemptId:'current-attempt'});
 const item=f.order().items[0],options={actorUid:'U',syncAttemptId:'current-attempt'};
 for(const patch of [{actorUid:'other'},{syncAttemptId:'old'}, {syncAttemptId:''}]){
  const before=JSON.stringify([...f.docs]);await assert.rejects(f.c.persistOrderProcurementDemands('O',f.order(),[item],{...options,...patch}));
  assert.equal(JSON.stringify([...f.docs]),before);
 }
 await f.c.persistOrderProcurementDemands('O',f.order(),[item],options);assert.equal(f.demand('I').remainingToOrderQty,5);
 f.put('orders/O',{...f.order(),inventoryReservationStatus:'completed'});const before=JSON.stringify([...f.docs]);
 await assert.rejects(f.c.persistOrderProcurementDemands('O',f.order(),[item],options),/較新的庫存同步/);assert.equal(JSON.stringify([...f.docs]),before);
 f.put('orders/O',{...f.order(),status:'cancelled'});await f.c.syncOrderProcurementDemandLifecycle('O',f.order(),'cancelled');
 assert.equal(f.demand('I').status,'CANCELLED');
});

// The old per-item writer is deliberately absent: initial order transactions
// belong to the authenticated, receipt-idempotent whole-order backend.
test('legacy initial SDK writer is absent from the built app and source',()=>{
 assert.doesNotMatch(source,/async function reserveSingleOrderItem/);
 assert.doesNotMatch(fs.readFileSync('src/services/order-reservation.js','utf8'),/reserveSingleOrderItem/);
 assert.doesNotMatch(source,/commitInitialGroupedReservationPreview/);
});
test('backend-off initialization refuses to write or create demand in every environment',async()=>{
 for(const environment of [undefined,'preview','production']){
  const f=fixture();if(environment)f.c.APP_ENVIRONMENT=environment;
  f.c.orderReservationBackendEnabled=()=>false;
  const before=JSON.stringify([...f.docs]);
  await assert.rejects(f.sync(),/後端尚未啟用.*SDK 寫入已停用/);
  assert.equal(JSON.stringify([...f.docs]),before);
  assert.equal(f.controls.selfCalls,0);
 }
});
test('backend completion is read fresh with no secondary browser stock transaction',async()=>{
 const f=fixture({onHand:5});let calls=0;
 f.c.orderReservationBackendEnabled=()=>true;
 f.c.commitNewOrderReservationPreview=async(id,live,actor)=>{
  calls++;assert.equal(id,'O');assert.equal(actor,'U');
  const item={...live.items[0],reservedQty:5,shortageQty:0,orderedQty:5};
  f.put('orders/O',{...live,items:[item],inventoryReservationStatus:'completed'});
  f.put('inventory/P',{...f.docs.get('inventory/P'),reserved:5});
  return true;
 };
 const result=await f.sync();
 assert.equal(calls,1);assert.equal(result.reservedQty,5);
 assert.equal(f.order().inventoryReservationStatus,'completed');
 assert.equal(f.docs.get('inventory/P').reserved,5);
 assert.equal(f.controls.selfCalls,1);
 assert.equal(f.docs.has('inventoryReservations/O__I'),false,
  'a browser-only test double cannot create a ledger after backend completion');
});
test('backend success reply without a completed source cannot launch self-order processing',async()=>{
 const f=fixture();f.c.orderReservationBackendEnabled=()=>true;
 f.c.commitNewOrderReservationPreview=async()=>true;
 const before=JSON.stringify([...f.docs]);
 await assert.rejects(f.sync(),/尚未確認整單預留完成/);
 assert.equal(JSON.stringify([...f.docs]),before);
 assert.equal(f.controls.selfCalls,0);
});
test('account switch after possible backend commit cannot launch self-order',async()=>{
 const f=fixture();f.c.orderReservationBackendEnabled=()=>true;
 f.c.commitNewOrderReservationPreview=async()=>{
  f.put('orders/O',{...f.order(),inventoryReservationStatus:'completed'});
  f.c.currentUser.uid='another-account';return true;
 };
 await assert.rejects(f.sync(),/訂單已變更/);
 assert.equal(f.controls.selfCalls,0);
});
test('newer reservation attempt rejects stale frontend before backend call',async()=>{
 const f=fixture();let calls=0;
 f.c.orderReservationBackendEnabled=()=>true;
 f.c.commitNewOrderReservationPreview=async()=>{calls++;return true;};
 const stale={...f.order(),inventoryReservationAttemptId:'old_attempt_123456'};
 f.put('orders/O',{...f.order(),inventoryReservationAttemptId:'new_attempt_123456'});
 const before=JSON.stringify([...f.docs]);
 await assert.rejects(f.c.reserveInventoryForNewOrder('O',stale),/已有較新的庫存同步工作/);
 assert.equal(calls,0);assert.equal(JSON.stringify([...f.docs]),before);
});
test('backend receipt from a superseded attempt cannot launch self-orders',async()=>{
 const f=fixture();let calls=0;
 f.put('orders/O',{...f.order(),inventoryReservationAttemptId:'original_123456789'});
 f.c.orderReservationBackendEnabled=()=>true;
 f.c.commitNewOrderReservationPreview=async()=>{
  calls++;
  f.put('orders/O',{...f.order(),inventoryReservationStatus:'completed',inventoryReservationAttemptId:'newer_123456789'});
  return true;
 };
 await assert.rejects(f.sync(),/已有較新的同步識別碼/);
 assert.equal(calls,1);assert.equal(f.controls.selfCalls,0);
});
test('cancellation after backend completion cannot launch initial self-order',async()=>{
 const f=fixture();f.c.orderReservationBackendEnabled=()=>true;
 f.c.commitNewOrderReservationPreview=async()=>{
  f.put('orders/O',{...f.order(),status:'cancelled',inventoryReservationStatus:'completed'});
  return true;
 };
 await assert.rejects(f.sync(),/已取消／作廢/);
 assert.equal(f.controls.selfCalls,0);
});
