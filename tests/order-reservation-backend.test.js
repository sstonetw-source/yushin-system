'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {commitOrderReservation,normalizeOrderReservationIntent}=require('../functions/order-reservation-service');
const {allowOrderReservationBackend}=require('../functions/order-reservation-gate');

function clone(v){return structuredClone(v);}
function fixture(){
 const docs=new Map(),put=(path,value)=>docs.set(path,clone(value));
 const db={collection:name=>({
  doc:id=>({path:name+'/'+id,id}),
  where:(field,op,value)=>({query:name,field,op,value})}),
  async runTransaction(work){
   const writes=[],tx={async get(ref){
    if(writes.length)throw Error('read after write: '+ref.path);
    if(ref.query){
     assert.equal(ref.op,'==');
     return {docs:[...docs].filter(([path,data])=>
      path.startsWith(ref.query+'/')&&!path.slice(ref.query.length+1).includes('/')
      &&data[ref.field]===ref.value).map(([path,value])=>({
       id:path.slice(ref.query.length+1),data:()=>clone(value)}))};
    }
    const value=docs.get(ref.path);
    return {exists:value!==undefined,data:()=>clone(value)};
   },set(ref,data,opts){writes.push({type:'set',path:ref.path,data:clone(data),opts});},
    update(ref,data){writes.push({type:'update',path:ref.path,data:clone(data)});},
    create(ref,data){writes.push({type:'create',path:ref.path,data:clone(data)});}};
   const response=await work(tx),next=new Map([...docs].map(([k,v])=>[k,clone(v)]));
   for(const write of writes){
    if(write.type==='create'&&next.has(write.path))throw Error('duplicate create');
    if(write.type==='update'&&!next.has(write.path))throw Error('missing update');
    next.set(write.path,{...(write.type==='update'||write.opts?.merge?next.get(write.path)||{}:{}),...write.data});
   }
   docs.clear();for(const [key,value] of next)docs.set(key,value);
   return response;
  }};
 put('users/actor',{active:true,role:'purchaser'});
 put('users/sales1',{active:true,role:'sales'});
 put('users/sales2',{active:true,role:'sales'});
 put('orders/O',{ownerUid:'sales1',salesCode:'S01',salesName:'Employee',status:'active',
  inventoryReservationStatus:'pending',inventoryReservationAttemptId:'sync_1234567890',items:[
   {itemId:'I1',productId:'P',warehouseId:'A',qty:3,reservedQty:0},
   {itemId:'I2',productId:'P',warehouseId:'A',qty:3,reservedQty:0},
   {itemId:'I3',productId:'Q',warehouseId:'B',qty:3,reservedQty:0},
   {itemId:'I4',productId:'D',fulfillmentType:'DIRECT_SHIP',qty:2,reservedQty:0}
  ]});
 for(const p of ['P','Q','D'])put('products/'+p,{productId:p,productType:'Goods',active:true});
 put('warehouses/A',{active:true});put('warehouses/B',{active:true});
 put('inventory/P',{productKey:'P',onHand:4,reserved:0,transferFreeInTransit:0});
 put('warehouseStocks/A__P',{productKey:'P',warehouseId:'A',onHand:4,reserved:0,transferFreeInTransit:0});
 put('inventory/Q',{productKey:'Q',onHand:2,reserved:0,transferFreeInTransit:0});
 put('warehouseStocks/B__Q',{productKey:'Q',warehouseId:'B',onHand:2,reserved:0,transferFreeInTransit:0});
 const request={orderId:'O',syncAttemptId:'sync_1234567890'};
 const snapshot=()=>JSON.stringify([...docs].sort(([a],[b])=>a.localeCompare(b)));
 return {docs,put,db,request,snapshot,
  run:(who='actor',data=request)=>commitOrderReservation(db,who,data)};
}
test('one backend transaction reserves all warehouse items and reconciles all supplier demands',async()=>{
 const f=fixture(),response=await f.run();
 assert.equal(response.status,'applied');assert.equal(response.reservedQty,6);assert.equal(response.shortageQty,3);
 const order=f.docs.get('orders/O');
 assert.deepEqual(order.items.map(x=>[x.reservedQty,x.shortageQty]),[[3,0],[1,2],[2,1],[0,0]]);
 assert.equal(order.inventoryReservationStatus,'completed');
 assert.equal(order.inventoryReservationError,'');
 assert.equal(order.inventoryReservationUpdatedAt!==undefined,true);
 assert.ok(order.workCategories.includes('ordering'));
 assert.ok(order.workCategories.includes('dispatch'));
 assert.equal(typeof order.workCategoryUpdatedAt,'string');
 assert.equal(f.docs.get('inventory/P').reserved,4);
 assert.equal(f.docs.get('warehouseStocks/A__P').reserved,4);
 assert.equal(f.docs.get('inventory/Q').reserved,2);
 assert.equal(f.docs.get('warehouseStocks/B__Q').reserved,2);
 assert.equal(f.docs.get('inventoryReservations/O__I1').quantity,3);
 assert.equal(f.docs.get('inventoryReservations/O__I2').quantity,1);
 assert.equal(f.docs.get('inventoryReservations/O__I3').quantity,2);
 assert.equal([...f.docs.keys()].filter(p=>p.startsWith('inventoryMovements/')).length,2);
 const demand=item=>f.docs.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:'+item));
 assert.equal(demand('I1'),undefined);
 assert.deepEqual([demand('I2').requestedQty,demand('I2').remainingToOrderQty],[2,2]);
 assert.equal(demand('I3').requestedQty,1);
 assert.equal(demand('I4').requestedQty,2);
 assert.equal(f.docs.get('reservationOperationReceipts/order-sync-O__sync_1234567890').actorUid,'actor');
});
test('confirmed sales self-orders fail closed before any reservation or supplier demand is written',async()=>{
 for(const options of [
  {selfOrderAtCreation:true,itemProcurementType:'SALES_SELF_ORDER'},
  {selfOrderAtCreation:false,itemProcurementType:'SALES_SELF_ORDER'},
  {selfOrderAtCreation:undefined,itemProcurementType:undefined,orderProcurementType:'SALES_SELF_ORDER'}
 ]){
  const f=fixture(),order=f.docs.get('orders/O');
  f.put('orders/O',{...order,selfOrderAtCreation:options.selfOrderAtCreation,
   procurementType:options.orderProcurementType,items:[
    {...order.items[0],procurementType:options.itemProcurementType,selfOrderConfirmed:true}
   ]});
  const before=f.snapshot();
  await assert.rejects(f.run('sales1'),/已確認自行訂貨尚無原子建單後端/);
  assert.equal(f.snapshot(),before);
  assert.equal(f.docs.has('inventoryReservations/O__I1'),false);
  assert.equal([...f.docs.keys()].some(key=>key.startsWith('procurementDemands/')),false);
 }
});
test('unconfirmed self-orders remain eligible for ordinary backend reservation',async()=>{
 const f=fixture(),order=f.docs.get('orders/O');
 f.put('orders/O',{...order,selfOrderAtCreation:true,items:[
  {...order.items[0],procurementType:'SALES_SELF_ORDER',selfOrderConfirmed:false}
 ]});
 const response=await f.run('sales1');
 assert.equal(response.status,'applied');
 assert.equal(f.docs.get('orders/O').inventoryReservationStatus,'completed');
});
test('a service-first mixed order reserves an untyped goods line without assigning it the service type',async()=>{
 const f=fixture(),order=f.docs.get('orders/O');
 f.put('products/S',{productType:'Service',active:true});
 f.put('products/P',{active:true});
 f.put('orders/O',{...order,productType:'Service',items:[
  {itemId:'S1',productId:'S',productType:'Service',qty:1},
  {...order.items[0],productType:''}
 ]});
 const response=await f.run('sales1');
 assert.deepEqual([response.reservedQty,response.shortageQty],[3,0]);
 const saved=f.docs.get('orders/O');
 assert.equal(saved.inventoryReservationStatus,'completed');
 assert.deepEqual(saved.workCategories,['ordering','delivery','dispatch']);
 assert.deepEqual(saved.items.map(item=>[item.productType,item.reservedQty]),[['Service',0],['Goods',3]]);
 assert.equal(f.docs.has('inventoryReservations/O__S1'),false);
 assert.equal(f.docs.get('inventoryReservations/O__I1').quantity,3);
 assert.equal([...f.docs.keys()].some(path=>path.startsWith('procurementDemands/')),false);
 const before=f.snapshot();
 assert.equal((await f.run('sales1')).status,'already-applied');
 assert.equal(f.snapshot(),before);
});
test('initial whole-order backend chooses an alternate single stocked warehouse without false procurement',async()=>{
 const f=fixture(),order=f.docs.get('orders/O');
 f.put('orders/O',{...order,items:[order.items[0]]});
 f.put('inventory/P',{productKey:'P',onHand:3,reserved:0});
 f.put('warehouseStocks/A__P',{productKey:'P',warehouseId:'A',onHand:0,reserved:0});
 f.put('warehouseStocks/B__P',{productKey:'P',warehouseId:'B',onHand:3,reserved:0});
 const result=await f.run();
 assert.deepEqual([result.reservedQty,result.shortageQty],[3,0]);
 const saved=f.docs.get('orders/O');
 assert.deepEqual([saved.items[0].warehouseId,saved.items[0].reservedQty],['B',3]);
 assert.equal(saved.inventoryReservationStatus,'completed');
 assert.equal(f.docs.get('inventoryReservations/O__I1').warehouseId,undefined);
 assert.deepEqual(f.docs.get('inventoryReservations/O__I1').locations,[{warehouseId:'B',reservedQty:3}]);
 assert.equal(f.docs.get('warehouseStocks/B__P').reserved,3);
 assert.equal(f.docs.get('warehouseStocks/A__P').reserved,0);
 assert.equal(f.docs.has('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I1')),false);
 const before=f.snapshot();assert.equal((await f.run()).status,'already-applied');
 assert.equal(f.snapshot(),before);
});
test('one alternate location can partially reserve and create only its genuine shortage',async()=>{
 const f=fixture(),order=f.docs.get('orders/O');
 f.put('orders/O',{...order,items:[order.items[0]]});
 f.put('inventory/P',{productKey:'P',onHand:2,reserved:0});
 f.put('warehouseStocks/A__P',{productKey:'P',warehouseId:'A',onHand:0,reserved:0});
 f.put('warehouseStocks/B__P',{productKey:'P',warehouseId:'B',onHand:2,reserved:0});
 const result=await f.run();
 assert.deepEqual([result.reservedQty,result.shortageQty],[2,1]);
 assert.deepEqual([f.docs.get('orders/O').items[0].warehouseId,
  f.docs.get('orders/O').items[0].shortageQty],['B',1]);
 assert.equal(f.docs.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I1')).requestedQty,1);
});
test('single-location ledger rejects a required multi-warehouse split without any writes',async()=>{
 const f=fixture(),order=f.docs.get('orders/O');
 f.put('orders/O',{...order,items:[order.items[0]]});
 f.put('inventory/P',{productKey:'P',onHand:4,reserved:0});
 f.put('warehouseStocks/A__P',{productKey:'P',warehouseId:'A',onHand:2,reserved:0});
 f.put('warehouseStocks/B__P',{productKey:'P',warehouseId:'B',onHand:2,reserved:0});
 const before=f.snapshot();
 await assert.rejects(f.run(),/需要多倉分配/);
 assert.equal(f.snapshot(),before);
});
test('company stock above enabled location totals or inactive candidates fails closed',async()=>{
 for(const inject of [
  f=>f.put('inventory/P',{productKey:'P',onHand:5,reserved:0}),
  f=>{f.put('inventory/P',{productKey:'P',onHand:3,reserved:0});
   f.put('warehouseStocks/A__P',{productKey:'P',warehouseId:'A',onHand:0,reserved:0});
   f.put('warehouses/B',{active:false});
   f.put('warehouseStocks/B__P',{productKey:'P',warehouseId:'B',onHand:3,reserved:0});},
  f=>{f.put('inventory/P',{productKey:'P',onHand:3,reserved:0});
   f.put('warehouseStocks/A__P',{productKey:'P',warehouseId:'A',onHand:0,reserved:0});
   f.put('warehouses/B',{active:true,warehouseType:'CUSTODY'});
   f.put('warehouseStocks/B__P',{productKey:'P',warehouseId:'B',onHand:3,reserved:0});},
  f=>f.put('warehouseStocks/incorrect',{productKey:'P',warehouseId:'B',onHand:3,reserved:0})
 ]){
  const f=fixture(),order=f.docs.get('orders/O');
  f.put('orders/O',{...order,items:[order.items[0]]});
  inject(f);const before=f.snapshot();
  await assert.rejects(f.run(),/公司可用庫存|分倉庫存識別/);
  assert.equal(f.snapshot(),before);
 }
});
test('repeated same-product order items choose single warehouses against remaining transactional stock',async()=>{
 const f=fixture(),order=f.docs.get('orders/O');
 f.put('orders/O',{...order,items:order.items.slice(0,2)});
 f.put('inventory/P',{productKey:'P',onHand:6,reserved:0});
 f.put('warehouseStocks/A__P',{productKey:'P',warehouseId:'A',onHand:3,reserved:0});
 f.put('warehouseStocks/B__P',{productKey:'P',warehouseId:'B',onHand:3,reserved:0});
 const result=await f.run();
 assert.deepEqual([result.reservedQty,result.shortageQty],[6,0]);
 assert.deepEqual(f.docs.get('orders/O').items.map(i=>[i.warehouseId,i.reservedQty]),
  [['A',3],['B',3]]);
 assert.equal(f.docs.get('inventory/P').reserved,6);
 assert.equal(f.docs.get('warehouseStocks/A__P').reserved,3);
 assert.equal(f.docs.get('warehouseStocks/B__P').reserved,3);
 assert.equal([...f.docs.keys()].filter(k=>k.startsWith('inventoryMovements/')).length,2);
});
test('repeated response after a commit is idempotent and does not double-charge stock',async()=>{
 const f=fixture();await f.run();const before=f.snapshot();
 assert.equal((await f.run()).status,'already-applied');
 assert.equal(f.snapshot(),before);
 await assert.rejects(f.run('sales1'),/憑證|呼叫者/);
 assert.equal(f.snapshot(),before);
});
test('insufficient or missing stock yields shortage and demand without partially changing stock',async()=>{
 const f=fixture();f.put('inventory/P',{productKey:'P',onHand:0,reserved:0});
 f.docs.delete('warehouseStocks/A__P');
 const result=await f.run();assert.equal(result.reservedQty,2);
 assert.equal(result.shortageQty,7);
 assert.equal(f.docs.get('inventory/P').reserved,0);
 assert.equal(f.docs.get('warehouseStocks/A__P').onHand,0);
 assert.equal(f.docs.get('inventoryReservations/O__I1').quantity,0);
 assert.equal(f.docs.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I1')).requestedQty,3);
});
test('existing unrelated reservation or supplier commitment fails the whole order atomically',async()=>{
 for(const inject of [
  f=>f.put('inventoryReservations/O__I2',{orderId:'O',itemId:'I2',productKey:'P',warehouseId:'A',quantity:1}),
  f=>f.put('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I3'),{
   demandId:'SALES_ORDER:O:I3',sourceType:'SALES_ORDER',sourceId:'O',sourceItemId:'I3',
   orderedQty:1,receivedQty:0}),
  f=>f.put('warehouseStocks/B__Q',{productKey:'Q',warehouseId:'B',onHand:2,reserved:3})
 ]){
  const f=fixture();inject(f);const before=f.snapshot();
  await assert.rejects(f.run(),/已有預留帳|採購需求|庫存帳目/);
  assert.equal(f.snapshot(),before);
 }
});
test('stale, cancelled, progressed or unauthorized sources are rejected without writes',async()=>{
 for(const mutate of [
  f=>f.put('users/actor',{role:'guest'}),
  f=>f.put('orders/O',{...f.docs.get('orders/O'),status:'cancelled'}),
  f=>f.put('orders/O',{...f.docs.get('orders/O'),inventoryReservationAttemptId:'other_123456789'}),
  f=>{const o=f.docs.get('orders/O');o.items[0].warehouseShippedQty=1;f.put('orders/O',o);},
  f=>{const o=f.docs.get('orders/O');o.items[2].reservedQty=1;f.put('orders/O',o);}
 ]){
  const f=fixture();mutate(f);const before=f.snapshot();
  await assert.rejects(f.run(),/權限|取消|較新的|尚未預留|帳號|沒有/);
  assert.equal(f.snapshot(),before);
 }
 const f=fixture(),before=f.snapshot();
 await assert.rejects(f.run('sales2'),/自己的訂單/);assert.equal(f.snapshot(),before);
 assert.equal((await f.run('sales1')).status,'applied');
});
test('caller cannot forge role, quantities, warehouse, or a replay from another order',async()=>{
 const f=fixture(),before=f.snapshot();
 for(const data of [
  {...f.request,warehouseId:'B'},
  {...f.request,items:[{itemId:'I1',quantity:99}]},
  {...f.request,role:'admin'},
  {...f.request,syncAttemptId:'short'}
 ])await assert.rejects(f.run('actor',data),/只允許|格式不正確/);
 assert.equal(f.snapshot(),before);
 assert.deepEqual(normalizeOrderReservationIntent(f.request),f.request);
});
test('source productKey cannot be forged and manual product codes use the canonical stock identity',async()=>{
 const bad=fixture(),order=bad.docs.get('orders/O');
 order.items[0].inventoryProductKey='Q';bad.put('orders/O',order);
 const before=bad.snapshot();
 await assert.rejects(bad.run(),/產品識別/);assert.equal(bad.snapshot(),before);
 const f=fixture(),manual=f.docs.get('orders/O');
 manual.items=[{itemId:'M1',itemCode:' a 100 ',inventoryProductKey:'code:A100',
  warehouseId:'A',qty:3,reservedQty:0}];
 f.put('orders/O',manual);
 f.put('inventory/'+encodeURIComponent('code:A100'),{productKey:'code:A100',onHand:6,reserved:0});
 f.put('warehouseStocks/'+encodeURIComponent('A')+'__'+encodeURIComponent('code:A100'),{
  productKey:'code:A100',warehouseId:'A',onHand:6,reserved:0});
 assert.equal((await f.run()).reservedQty,3);
 assert.equal(f.docs.get('inventory/'+encodeURIComponent('code:A100')).reserved,3);
});
test('single-item and mixed service/direct-ship orders have correct projections',async()=>{
 const f=fixture(),order=f.docs.get('orders/O');
 f.put('products/S',{productId:'S',productType:'SERVICE',active:true});
 f.put('orders/O',{...order,items:[
  {itemId:'S',productId:'S',productType:'SERVICE',qty:1},
  {itemId:'D',productId:'D',fulfillmentType:'DIRECT_SHIP',qty:3}
 ]});
 const result=await f.run();assert.equal(result.reservedQty,0);
 assert.equal(result.shortageQty,0);
 assert.equal(f.docs.get('orders/O').items[0].reservationStatus,'not_required');
 assert.equal(f.docs.get('orders/O').items[1].reservationStatus,'not_required');
 assert.equal(f.docs.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:D')).requestedQty,3);
 assert.equal([...f.docs.keys()].filter(k=>k.startsWith('inventoryMovements/')).length,0);
 const single=fixture(),original=single.docs.get('orders/O');
 single.put('orders/O',{...original,items:[original.items[0]]});
 assert.equal((await single.run()).reservedQty,3);
});
test('new service orders enter the purchase work queue without physical demand',async()=>{
 const f=fixture(),order=f.docs.get('orders/O');
 f.put('products/S',{productId:'S',productType:'SERVICE',active:true});
 f.put('orders/O',{...order,items:[{itemId:'S',productId:'S',productType:'SERVICE',qty:1}],
  workCategories:['billing'],workCategoryUpdatedAt:'2026-10-30T00:00:00.000Z'});
 await f.run();
 const saved=f.docs.get('orders/O');
 assert.equal(saved.inventoryReservationStatus,'completed');
 assert.deepEqual(saved.workCategories,['ordering']);
 assert.deepEqual(saved.serviceFulfillment,{});
 assert.equal([...f.docs.keys()].filter(key=>key.startsWith('procurementDemands/')).length,0);
});
test('new order backend is independently disabled by default, in production and without dual emulator',()=>{
 for(const env of [
  {},{ENABLE_ORDER_RESERVATION_BACKEND:'true',GCLOUD_PROJECT:'yu-shing-company'},
  {ENABLE_PRODUCTION_ORDER_RESERVATION_BACKEND:'true',GCLOUD_PROJECT:'yu-shing-company'},
  {ENABLE_ORDER_RESERVATION_BACKEND:'true',GCLOUD_PROJECT:'demo-yushin'},
  {ENABLE_ORDER_RESERVATION_BACKEND:'true',GCLOUD_PROJECT:'demo-yushin',FIRESTORE_EMULATOR_HOST:'localhost:8080'}
 ])assert.equal(allowOrderReservationBackend(env),false);
 assert.equal(allowOrderReservationBackend({ENABLE_ORDER_RESERVATION_BACKEND:'true',GCLOUD_PROJECT:'preview-20135'}),true);
 assert.equal(allowOrderReservationBackend({ENABLE_ORDER_RESERVATION_BACKEND:'true',
  ENABLE_PRODUCTION_ORDER_RESERVATION_BACKEND:'true',GCLOUD_PROJECT:'yu-shing-company'}),true);
 for(const env of [
  {FIRESTORE_EMULATOR_HOST:'localhost:8080'},
  {FIREBASE_AUTH_EMULATOR_HOST:'localhost:9099'},
  {FUNCTIONS_EMULATOR:'true'}
 ])assert.equal(allowOrderReservationBackend({ENABLE_ORDER_RESERVATION_BACKEND:'true',
   ENABLE_PRODUCTION_ORDER_RESERVATION_BACKEND:'true',GCLOUD_PROJECT:'yu-shing-company',...env}),false);
 assert.equal(allowOrderReservationBackend({ENABLE_ORDER_RESERVATION_BACKEND:'true',GCLOUD_PROJECT:'demo-yushin',
  FUNCTIONS_EMULATOR:'true',FIRESTORE_EMULATOR_HOST:'localhost:8080',FIREBASE_AUTH_EMULATOR_HOST:'localhost:9099'}),true);
});

test('authenticated admin reserves their own explicitly code-free order without changing ownership',async()=>{
 const f=fixture(),order=f.docs.get('orders/O');
 f.put('users/actor',{active:true,role:'admin'});
 f.put('orders/O',{...order,ownerUid:'actor',salesCode:'',createdByRole:'admin',createdByUid:'actor'});
 const result=await f.run();assert.equal(result.status,'applied');
 const saved=f.docs.get('orders/O');assert.equal(saved.ownerUid,'actor');assert.equal(saved.salesCode,'');
 assert.equal(saved.inventoryReservationStatus,'completed');assert.equal(f.docs.get('inventory/P').reserved,4);
 const demand=f.docs.get('procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I2'));
 assert.equal(demand.ownerUid,'actor');assert.equal(demand.salesCode,'');
 const before=f.snapshot();assert.equal((await f.run()).status,'already-applied');assert.equal(f.snapshot(),before);
});

test('missing salesperson code stays rejected for commercial roles, assistants, foreign owners and forged admin metadata',async()=>{
 for(const [role,owner,code] of [['sales','actor',''],['engineer','actor',''],['purchaser','actor',''],['warehouse','actor',''],['admin','sales1',''],['admin','actor',undefined]]){
  const f=fixture(),order=f.docs.get('orders/O');f.put('users/actor',{active:true,role});
  const next={...order,ownerUid:owner,createdByRole:'admin',createdByUid:'actor'};
  if(code===undefined)delete next.salesCode;else next.salesCode=code;
  f.put('orders/O',next);const before=f.snapshot();
  await assert.rejects(()=>f.run(),error=>error.code==='failed-precondition');assert.equal(f.snapshot(),before);
 }
});

test('authorized purchasing can reserve an active administrator-owned order without reassigning its blank code',async()=>{
 const f=fixture(),order=f.docs.get('orders/O');
 f.put('users/owner-admin',{active:true,role:'admin'});
 f.put('orders/O',{...order,ownerUid:'owner-admin',salesCode:''});
 assert.equal((await f.run()).status,'applied');
 assert.equal(f.docs.get('orders/O').ownerUid,'owner-admin');
 assert.equal(f.docs.get('orders/O').salesCode,'');
 for(const profile of [null,{role:'sales',active:true},{role:'admin',active:false},{role:'admin',disabled:true}]){
  const bad=fixture();bad.put('orders/O',{...bad.docs.get('orders/O'),ownerUid:'owner-admin',salesCode:'',createdByRole:'admin'});
  if(profile)bad.put('users/owner-admin',profile);
  const before=bad.snapshot();await assert.rejects(()=>bad.run(),error=>error.code==='failed-precondition');assert.equal(bad.snapshot(),before);
 }
});


test('new orders persist only the fulfillment v2 location contract, including zero holds',async()=>{
 const f=fixture();await f.run();
 const core=require('../functions/shared/reservation-core');
 for(const item of f.docs.get('orders/O').items.filter(i=>i.fulfillmentType!=='DIRECT_SHIP')){
  const ledger=f.docs.get('inventoryReservations/O__'+item.itemId);
  assert.equal(ledger.locationSchemaVersion,2);
  assert.equal(Object.hasOwn(ledger,'warehouseId'),false);
  assert.deepEqual(ledger.lifecycleWarehouseIds,['A','B']);
  assert.equal(core.reservationLocations(ledger).reduce((sum,r)=>sum+r.qty,0),item.reservedQty);
  assert.equal(ledger.shortageQty,item.shortageQty);
 }
 const before=f.snapshot();await f.run();assert.equal(f.snapshot(),before);
 const zero=fixture();zero.put('inventory/P',{productKey:'P',onHand:0,reserved:0});
 zero.docs.delete('warehouseStocks/A__P');await zero.run();
 const ledger=zero.docs.get('inventoryReservations/O__I1');
 assert.equal(ledger.locationSchemaVersion,2);assert.deepEqual(ledger.locations,[]);
 assert.equal(ledger.quantity,0);assert.equal(ledger.shortageQty,3);
});

test('new initialization rejects even an empty existing ledger rather than migrating it',async()=>{
 const f=fixture();f.put('inventoryReservations/O__I1',{
  orderId:'O',itemId:'I1',productKey:'P',warehouseId:'A',quantity:0
 });
 const before=f.snapshot();await assert.rejects(f.run(),/已有預留帳/);
 assert.equal(f.snapshot(),before);
});


test('different orders may use the same synchronization ID without movement collisions',async()=>{
 const f=fixture();await f.run();
 const order=clone(f.docs.get('orders/O'));
 for(const item of order.items){item.reservedQty=0;item.shortageQty=0;}
 order.inventoryReservationStatus='pending';
 f.put('orders/O2',order);
 f.put('inventory/P',{...f.docs.get('inventory/P'),onHand:8});
 f.put('warehouseStocks/A__P',{...f.docs.get('warehouseStocks/A__P'),onHand:8});
 await f.run('actor',{...f.request,orderId:'O2'});
 const moves=[...f.docs].filter(([path])=>path.startsWith('inventoryMovements/')).map(([,data])=>data);
 assert.ok(moves.some(row=>row.sourceId==='O'));
 assert.ok(moves.some(row=>row.sourceId==='O2'));
 assert.equal(f.docs.get('inventory/P').reserved,8);
});


test('v2 initialization materializes missing zero balances for every shared lifecycle candidate',async()=>{
 const f=fixture();f.docs.delete('inventory/Q');f.docs.delete('warehouseStocks/B__Q');
 await f.run();
 for(const key of ['P','Q'])for(const wh of ['A','B']){
  const stock=f.docs.get('warehouseStocks/'+wh+'__'+key);
  assert.equal(stock.productKey,key);assert.equal(stock.warehouseId,wh);
  assert.equal(Number.isSafeInteger(stock.onHand),true);
 }
 assert.equal(f.docs.get('inventory/Q').onHand,0);
 assert.equal(f.docs.get('inventory/Q').reserved,0);
 assert.equal(f.docs.get('warehouseStocks/A__Q').onHand,0);
});

test('three candidate warehouses reject before creating an unusable lifecycle source',async()=>{
 const f=fixture();f.put('warehouses/C',{active:true});
 f.put('warehouseStocks/C__P',{productKey:'P',warehouseId:'C',onHand:0,reserved:0});
 const before=f.snapshot();await assert.rejects(f.run(),/1–2 個候選/);assert.equal(f.snapshot(),before);
});

test('encoded product identities create canonical zero company and warehouse ledgers without a second encoding',async()=>{
 const f=fixture();
 const keys=['prd:%E9%9B%9C%E9%A0%85:golive20261104p01','prd:Beckman Coulter:TEST'];
 for(const path of [...f.docs.keys()])if(path.startsWith('inventory/')||path.startsWith('warehouseStocks/'))f.docs.delete(path);
 for(const key of keys)f.put('products/'+key,{productType:'Consumable',active:true});
 f.put('orders/O',{...f.docs.get('orders/O'),items:keys.map((key,i)=>({
  itemId:'I'+i,productId:key,warehouseId:i?'B':'A',qty:1,reservedQty:0}))});
 const result=await f.run();assert.deepEqual([result.reservedQty,result.shortageQty],[0,2]);
 for(const key of keys){
  const company=f.docs.get('inventory/'+encodeURIComponent(key));
  assert.equal(company.productKey,key);
  assert.deepEqual([company.onHand,company.reserved,company.incoming],[0,0,0]);
  for(const wh of ['A','B']){
   const stock=f.docs.get('warehouseStocks/'+wh+'__'+encodeURIComponent(key));
   assert.ok(stock,'candidate ledger exists for raw identity');
   assert.equal(stock.productKey,key);assert.equal(stock.warehouseId,wh);
   assert.deepEqual([stock.onHand,stock.reserved,stock.incoming],[0,0,0]);
   assert.equal(f.docs.has('warehouseStocks/'+wh+'__'+encodeURIComponent(encodeURIComponent(key))),false);
  }
 }
 const before=f.snapshot();assert.equal((await f.run()).status,'already-applied');assert.equal(f.snapshot(),before);
});
