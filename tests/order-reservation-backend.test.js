'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {commitOrderReservation,normalizeOrderReservationIntent}=require('../functions/order-reservation-service');
const {allowOrderReservationBackend}=require('../functions/order-reservation-gate');

function clone(v){return structuredClone(v);}
function fixture(){
 const docs=new Map(),put=(path,value)=>docs.set(path,clone(value));
 const db={collection:name=>({doc:id=>({path:name+'/'+id,id})}),
  async runTransaction(work){
   const writes=[],tx={async get(ref){
    if(writes.length)throw Error('read after write: '+ref.path);
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
 put('inventory/P',{productKey:'P',onHand:7,reserved:0,transferFreeInTransit:0});
 put('warehouseStocks/A__P',{productKey:'P',warehouseId:'A',onHand:4,reserved:0,transferFreeInTransit:0});
 put('inventory/Q',{productKey:'Q',onHand:6,reserved:0,transferFreeInTransit:0});
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
 assert.equal(order.inventoryReservationStatus,'pending');
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
 assert.equal(f.docs.has('warehouseStocks/A__P'),false);
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
  await assert.rejects(f.run(),/舊預留|採購需求|庫存帳目/);
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
 f.put('inventory/'+encodeURIComponent('code:A100'),{productKey:'code:A100',onHand:8,reserved:0});
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
test('new order backend is independently disabled by default, in production and without dual emulator',()=>{
 for(const env of [
  {},{ENABLE_ORDER_RESERVATION_BACKEND:'true',GCLOUD_PROJECT:'yu-shing-company'},
  {ENABLE_ORDER_RESERVATION_BACKEND:'true',GCLOUD_PROJECT:'demo-yushin'},
  {ENABLE_ORDER_RESERVATION_BACKEND:'true',GCLOUD_PROJECT:'demo-yushin',FIRESTORE_EMULATOR_HOST:'localhost:8080'}
 ])assert.equal(allowOrderReservationBackend(env),false);
 assert.equal(allowOrderReservationBackend({ENABLE_ORDER_RESERVATION_BACKEND:'true',GCLOUD_PROJECT:'preview-20135'}),true);
 assert.equal(allowOrderReservationBackend({ENABLE_ORDER_RESERVATION_BACKEND:'true',GCLOUD_PROJECT:'demo-yushin',
  FUNCTIONS_EMULATOR:'true',FIRESTORE_EMULATOR_HOST:'localhost:8080',FIREBASE_AUTH_EMULATOR_HOST:'localhost:9099'}),true);
});
