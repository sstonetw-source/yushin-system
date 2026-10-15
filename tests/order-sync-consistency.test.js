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
 f.put('warehouses/W2',{active:true});
 f.put('inventoryReservations/O__I',{orderId:'O',itemId:'I',productKey:'P',warehouseId:'W',quantity:4});
 await f.sync();assert.equal(f.docs.get('inventory/P').reserved,4);assert.equal(f.docs.get('warehouseStocks/W__P').reserved,0);
 assert.equal(f.docs.get('warehouseStocks/W2__P').reserved,4);assert.equal(f.docs.get('inventoryReservations/O__I').warehouseId,'W2');
});
test('missing product publishes an explicit error without inventing physical inventory',async()=>{
 const f=fixture({items:[{itemId:'I',qty:3}]});await f.sync();assert.equal(f.order().items[0].reservationError,'missing_product_master');
 assert.equal([...f.docs.keys()].some(k=>k.startsWith('inventoryReservations/')),false);assert.equal(f.demand('I').remainingToOrderQty,3);
});

function addWarehouse(f,id,onHand,{reserved=0,incoming=0,transferInTransit=0,...master}={}){
 f.put('warehouses/'+id,{active:true,...master});
 f.put('warehouseStocks/'+id+'__P',{productKey:'P',warehouseId:id,onHand,reserved,incoming,transferInTransit});
 f.c.warehouseMasterCache.push({id,active:true});
}
test('another warehouse covers the complete item without adding stock or false purchasing demand',async()=>{
 const f=fixture({onHand:0});addWarehouse(f,'W2',5);f.put('inventory/P',{productKey:'P',onHand:5,reserved:0});
 await f.sync();const item=f.order().items[0];
 assert.equal(item.warehouseId,'W2');assert.equal(item.reservedQty,5);assert.equal(item.shortageQty,0);assert.equal(item.qty,5);
 assert.equal(f.docs.get('inventoryReservations/O__I').warehouseId,'W2');assert.equal(f.docs.get('inventory/P').onHand,5);
 assert.equal(f.docs.get('warehouseStocks/W__P').reserved,0);assert.equal(f.docs.get('warehouseStocks/W2__P').reserved,5);
 assert.equal(f.demand('I'),undefined);
});
test('initial hint stays preferred when it can cover the whole item; other warehouse is not chosen by size',async()=>{
 const f=fixture({onHand:5});addWarehouse(f,'W2',100);f.put('inventory/P',{productKey:'P',onHand:105,reserved:0});
 await f.sync();assert.equal(f.order().items[0].warehouseId,'W');assert.equal(f.docs.get('warehouseStocks/W2__P').reserved,0);
});
test('partial default stock is left free when a different warehouse covers the whole item',async()=>{
 const f=fixture({onHand:2});addWarehouse(f,'W2',5);f.put('inventory/P',{productKey:'P',onHand:7,reserved:0});
 await f.sync();assert.equal(f.order().items[0].warehouseId,'W2');assert.equal(f.docs.get('warehouseStocks/W__P').reserved,0);
});
test('a single stocked remote warehouse covers partial quantity and purchasing receives only the company gap',async()=>{
 const f=fixture({onHand:0});addWarehouse(f,'W2',3);f.put('inventory/P',{productKey:'P',onHand:3,reserved:0});await f.sync();
 assert.equal(f.order().items[0].warehouseId,'W2');assert.equal(f.order().items[0].reservedQty,3);assert.equal(f.demand('I').remainingToOrderQty,2);
 assert.equal(f.demand('I').warehouseId,'W2');assert.equal(f.docs.get('warehouseStocks/W2__P').reserved,3);
});
test('zero reservation and existing demand recover to another warehouse without ghost stock or duplicate reserve',async()=>{
 const f=fixture({onHand:0});await f.sync();assert.equal(f.demand('I').remainingToOrderQty,5);
 addWarehouse(f,'W2',5);f.put('inventory/P',{productKey:'P',onHand:5,reserved:0});
 await f.sync();await f.sync();
 assert.equal(f.order().items[0].warehouseId,'W2');assert.equal(f.demand('I').warehouseId,'W2');assert.equal(f.demand('I').remainingToOrderQty,0);
 assert.equal(f.docs.get('inventoryReservations/O__I').quantity,5);assert.equal(f.docs.get('warehouseStocks/W2__P').reserved,5);
 assert.equal([...f.docs.values()].filter(x=>x.type==='reserve').length,1);
});
test('same-product lines and simultaneous orders compete for the same live warehouse stock',async()=>{
 const f=fixture({onHand:0});addWarehouse(f,'W2',5);f.put('inventory/P',{productKey:'P',onHand:5,reserved:0});
 const other=structuredClone(f.order());other.id='O2';f.put('orders/O2',other);
 await Promise.all([f.sync(),f.c.reserveSingleOrderItem('O2',other,other.items[0],0)]);
 const items=[f.order().items[0],f.docs.get('orders/O2').items[0]];
 assert.equal(items.reduce((sum,i)=>sum+i.reservedQty,0),5);assert.equal(items.filter(i=>i.warehouseId==='W2').length,1);
 assert.equal(f.docs.get('warehouseStocks/W2__P').reserved,5);assert.equal(f.docs.get('inventory/P').reserved,5);
 const repeated=fixture({onHand:0,items:[{itemId:'I',productId:'P',warehouseId:'W',qty:5},{itemId:'J',productId:'P',warehouseId:'W',qty:5}]});
 addWarehouse(repeated,'W2',10);repeated.put('inventory/P',{productKey:'P',onHand:10,reserved:0});await repeated.sync();
 assert.deepEqual(repeated.order().items.map(i=>i.reservedQty),[5,5]);assert.equal(repeated.docs.get('warehouseStocks/W2__P').reserved,10);
});
test('disabled and custody stock are excluded; supplier incoming and transfer transit never count as ready stock',async()=>{
 const f=fixture({onHand:0});addWarehouse(f,'OFF',5,{active:false});addWarehouse(f,'custody-U',5,{systemCustody:true});
 addWarehouse(f,'INCOMING',0,{incoming:5});addWarehouse(f,'TRANSIT',0,{transferInTransit:5});
 f.put('inventory/P',{productKey:'P',onHand:10,reserved:0,incoming:10,transferInTransit:5});await assert.rejects(f.sync(),/核對分倉庫存/);
 assert.equal(f.order().items[0].warehouseId,'W');assert.equal(f.order().items[0].reservedQty||0,0);assert.equal(f.demand('I'),undefined);
});
test('live warehouse deactivation during a transaction retry prevents reservation there',async()=>{
 const f=fixture({onHand:0});addWarehouse(f,'W2',5);f.put('inventory/P',{productKey:'P',onHand:5,reserved:0});
 f.controls.beforeCommit=()=>f.put('warehouses/W2',{active:false});await assert.rejects(f.sync(),/核對分倉庫存/);
 assert.equal(f.order().items[0].warehouseId,'W');assert.equal(f.docs.get('warehouseStocks/W2__P').reserved,0);
});
test('existing physical reservation or supplier progress locks automatic location selection',async()=>{
 for(const progress of [{reservedQty:2},{supplyOrderedQty:3},{supplyOrderedQty:3,receivedQty:1},{dispatchPreparedQty:1},{deliveredQty:1},{returnedQty:1},{custodyTransferId:'HAND'}]){
  const f=fixture({onHand:2});addWarehouse(f,'W2',5);f.put('inventory/P',{productKey:'P',onHand:7,reserved:Number(progress.reservedQty||0)});
  f.put('orders/O',{...f.order(),items:[{...f.order().items[0],...progress}]});
  if(progress.reservedQty){f.put('warehouseStocks/W__P',{productKey:'P',warehouseId:'W',onHand:2,reserved:2});f.put('inventoryReservations/O__I',{orderId:'O',itemId:'I',productKey:'P',warehouseId:'W',quantity:2});}
  await f.sync();assert.equal(f.order().items[0].warehouseId,'W');assert.equal(f.docs.get('warehouseStocks/W2__P').reserved,0);
 }
 const history=fixture({onHand:0});addWarehouse(history,'W2',5);history.put('inventory/P',{productKey:'P',onHand:5,reserved:0});
 history.put('orders/O',{...history.order(),deliveryRecords:[{itemId:'I',qty:1}]});await history.sync();
 assert.equal(history.order().items[0].warehouseId,'W');assert.equal(history.docs.get('warehouseStocks/W2__P').reserved,0);
});
test('company aggregate still bounds another warehouse selection and missing current master cannot silently reserve',async()=>{
 const f=fixture({onHand:0});addWarehouse(f,'W2',5);f.put('inventory/P',{productKey:'P',onHand:2,reserved:0});await assert.rejects(f.sync(),/多倉分配/);
 assert.equal(f.order().items[0].warehouseId,'W');assert.equal(f.docs.get('warehouseStocks/W2__P').reserved,0);
 const missing=fixture();missing.docs.delete('warehouses/W');const before=JSON.stringify([...missing.docs]);
 await assert.rejects(missing.sync(),/啟用的庫存倉庫/);assert.equal(JSON.stringify([...missing.docs]),before);
});
test('company free stock missing from eligible physical locations stops without publishing false demand',async()=>{
 for(const onHand of [0,2]){
  const f=fixture({onHand});f.put('inventory/P',{productKey:'P',onHand:5,reserved:0});
  const before=JSON.stringify([...f.docs]);await assert.rejects(f.sync(),/核對分倉庫存/);
  assert.equal(JSON.stringify([...f.docs]),before);assert.equal(f.demand('I'),undefined);
 }
});
test('stock stranded in a disabled warehouse cannot silently become a new purchase shortage',async()=>{
 const f=fixture({onHand:2});addWarehouse(f,'W2',3);f.put('warehouses/W2',{active:false});
 f.put('inventory/P',{productKey:'P',onHand:5,reserved:0});
 const before=JSON.stringify([...f.docs]);await assert.rejects(f.sync(),/核對分倉庫存/);
 assert.equal(JSON.stringify([...f.docs]),before);
});
test('multiple partial locations stop safely rather than creating false procurement shortage',async()=>{
 for(const remote of [1,3,4]){
  const f=fixture({onHand:2});addWarehouse(f,'W2',remote);f.put('inventory/P',{productKey:'P',onHand:2+remote,reserved:0});const before=JSON.stringify([...f.docs]);
  await assert.rejects(f.sync(),/多倉分配/);assert.equal(JSON.stringify([...f.docs]),before);assert.equal(f.demand('I'),undefined);
 }
});
test('master refresh failure or account change cannot publish a stale warehouse choice',async()=>{
 const f=fixture();f.c.loadWarehouseMaster=async()=>{f.c.warehouseMasterLoadPromise=null;};const before=JSON.stringify([...f.docs]);
 await assert.rejects(f.sync(),/倉庫主檔讀取失敗/);assert.equal(JSON.stringify([...f.docs]),before);
 const switched=fixture();switched.controls.beforeCommit=()=>{switched.c.currentUser={uid:'OTHER'};switched.put('orders/O',{...switched.order(),remarks:'conflict'});};
 await assert.rejects(switched.sync(),/登入身份已變更/);assert.equal(switched.docs.get('inventory/P').reserved,0);
});
test('direct shipment skips warehouse discovery and an account switch during master refresh stops all writes',async()=>{
 const direct=fixture({items:[{itemId:'I',productId:'P',qty:3,fulfillmentType:'DIRECT_SHIP'}]});
 direct.c.loadWarehouseMaster=async()=>{throw Error('direct shipment must not read warehouses');};await direct.sync();
 assert.equal(direct.demand('I').remainingToOrderQty,3);
 const switched=fixture();switched.c.loadWarehouseMaster=async()=>{switched.c.currentUser={uid:'OTHER'};};const before=JSON.stringify([...switched.docs]);
 await assert.rejects(switched.sync(),/登入身份已變更/);assert.equal(JSON.stringify([...switched.docs]),before);assert.equal(switched.controls.selfCalls,0);
});
test('automatic remote allocation flows through printing, transfer transit, receipt and physical shipment',async()=>{
 const f=fixture({onHand:0});addWarehouse(f,'W2',5);f.put('inventory/P',{productKey:'P',productId:'P',onHand:5,reserved:0});
 f.put('inventoryLots/REMOTE',{productKey:'P',productId:'P',warehouseId:'W2',remainingQty:5,qty:5,lotNo:'L',expiryDate:'2027-01-01'});
 await f.sync();const original=f.order();
 f.put('orders/O',{...original,inventoryReservationStatus:'completed',items:[fulfillment.prepareDispatch({...original.items[0],deliveryPlan:{mode:'PICKUP'}},5)]});
 const core=require('../modules/warehouse-logistics'),baseCollection=f.c.db.collection;
 f.c.db.collection=name=>({...baseCollection(name),where(field,op,value){
  const filters=[[field,op,value]],q={where(k,o,v){filters.push([k,o,v]);return q;},limit(){return q;},get:async()=>{
   const rows=[...f.docs].filter(([path,data])=>path.startsWith(name+'/')&&filters.every(([k,o,v])=>o==='>'?data[k]>v:data[k]===v));
   return {size:rows.length,docs:rows.map(([path,data])=>({id:path.split('/').at(-1),ref:baseCollection(name).doc(path.split('/').at(-1)),exists:true,data:()=>structuredClone(data)}))};}};return q;
 }});
 Object.assign(f.c,{YushinWarehouseLogistics:core,currentUserRole:'purchaser',canReceiveInventoryCapability:()=>true,canAccessPage:()=>true,
  deliveryActor:()=> 'Buyer',orderInventorySyncIncomplete:o=>['pending','failed'].includes(o.inventoryReservationStatus),
  itemDispatchState:(_o,item)=>fulfillment.dispatchState(item),DOCUMENT_TYPES:{ORDER:'order'},
  firebase:{firestore:{FieldValue:{arrayUnion:v=>({__arrayUnion:[v]})}}}});
 const logisticsSource=fs.readFileSync('modules/warehouse-logistics.js','utf8');
 vm.runInContext(logisticsSource.slice(logisticsSource.indexOf('async function commitWarehouseTransfer(')),f.c);
 vm.runInContext(section('function inventoryReservationPayload(', 'window.openInventoryReservationDetails ='),f.c);
 vm.runInContext(section('async function applyInventoryDeliveryDeltaInTransaction(', 'async function applyInventoryReturnDeltaInTransaction('),f.c);
 const branchItem=f.order().items[0];assert.equal(core.businessDeliveryState(f.order(),branchItem,fulfillment.dispatchState(branchItem),'W').shippable,0);
 await f.c.commitWarehouseTransfer({id:'REMOTE-TO-MAIN',orderId:'O',itemId:'I',qty:5,toWarehouseId:'W'});
 assert.equal(f.order().items[0].transferPendingId,'REMOTE-TO-MAIN');assert.equal(f.docs.get('inventory/P').transferInTransit,5);
 assert.equal(f.docs.get('inventory/P').onHand,5);assert.equal(f.docs.get('warehouseStocks/W2__P').onHand,0);
 await assert.rejects(f.c.runRoleTransaction(tx=>f.c.applyInventoryDeliveryDeltaInTransaction(tx,{...f.order(),...f.order().items[0]},5,'Sales','O')),/調撥途中/);
 await f.c.commitWarehouseTransferReceipt('REMOTE-TO-MAIN');await f.c.commitWarehouseTransferReceipt('REMOTE-TO-MAIN');
 const received=f.order().items[0];assert.equal(received.warehouseId,'W');assert.equal(received.transferPendingId,'');
 assert.equal(f.docs.get('warehouseStocks/W__P').onHand,5);assert.equal(f.docs.get('warehouseStocks/W__P').reserved,5);
 assert.equal(f.docs.get('inventory/P').onHand,5);assert.equal(f.docs.get('inventory/P').transferInTransit,0);
 assert.equal((f.order().deliveryRecords||[]).length,0);assert.equal(core.businessDeliveryState(f.order(),received,fulfillment.dispatchState(received),'W').shippable,5);
 await f.c.runRoleTransaction(async tx=>{
  const result=await f.c.applyInventoryDeliveryDeltaInTransaction(tx,{...f.order(),...received,requireStockReservation:true},5,'Sales','O');
  tx.update(f.c.db.collection('orders').doc('O'),{items:[{...fulfillment.deliver(received,5),reservedQty:result.newReservedQty}],deliveryRecords:[{id:'DELIVER',itemId:'I',qty:5,lotAllocations:result.lotAllocations}]});
 });
 assert.equal(f.docs.get('warehouseStocks/W__P').onHand,0);assert.equal(f.docs.get('inventory/P').onHand,0);assert.equal(f.docs.get('inventory/P').reserved,0);
 assert.equal(f.docs.get('inventoryReservations/O__I').quantity,0);
 assert.equal(f.order().deliveryRecords[0].qty,5);assert.equal(f.order().items[0].deliveredQty,5);
});
