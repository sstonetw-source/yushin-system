'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {custodyShipmentProject,commitCustodyShipment}=require('../functions/custody-shipment-service');
const {commitCustodyDelivery}=require('../functions/custody-delivery-service');
const {commitShipmentDelivery}=require('../functions/shipment-delivery-service');
const {commitCustodyReturn}=require('../functions/custody-return-service');
const env={GCLOUD_PROJECT:'demo-yushin',FUNCTIONS_EMULATOR:'true',
 FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099',
 ENABLE_V3_CUSTODY_SHIPMENT_EMULATOR:'true'};
function fixture(){
 const owner='SALES',custody='custody-'+owner,orderId='ORDER',itemId='I',productKey='P',transferId='HANDOFF';
 const docs=new Map(),clone=value=>structuredClone(value),put=(path,data)=>docs.set(path,clone(data));
 const handoffPlan={mode:'PICKUP',contact:'',phone:'',address:'',warehouseId:'',packages:1,notes:''};
 put('users/SALES',{role:'sales',active:true});
 put('users/OTHER',{role:'sales',active:true});
 put('users/ADMIN',{role:'admin',active:true});
 put('products/P',{active:true,productType:'Goods'});
 put('warehouses/'+custody,{active:true,systemCustody:true,warehouseType:'CUSTODY',ownerUid:owner});
 put('inventory/P',{productKey,onHand:5,reserved:4});
 put('warehouseStocks/'+custody+'__P',{productKey,warehouseId:custody,onHand:3,reserved:3});
 put('orders/ORDER',{status:'active',orderStatus:'normal',inventoryReservationStatus:'completed',
  inventoryReservationAttemptId:'sync_123456789',ownerUid:owner,salesCode:'S01',logisticsTransfersPending:0,
  warehouseShipmentRecords:[],deliveryRecords:[],returnRecords:[],deliveredQty:0,returnedQty:0,isDelivered:false,
  items:[{itemId,qty:3,productId:productKey,warehouseId:custody,custodyTransferId:transferId,
   deliveryPlan:handoffPlan,reservedQty:3,shortageQty:0,dispatchPreparedQty:3,warehouseShippedQty:0}]});
 put('inventoryReservations/ORDER__I',{orderId,itemId,productKey,ownerUid:owner,salesCode:'S01',
  locationSchemaVersion:3,quantity:3,shortageQty:0,status:'active',
  locations:[{warehouseId:custody,reservedQty:3}],lifecycleWarehouseIds:['A','B'],
  sourceLocationSnapshot:[{warehouseId:'A',reservedQty:3}],custodyOriginalQty:3,custodyTransferId:transferId});
 const transfer={id:transferId,kind:'HANDOFF',status:'RECEIVED',orderId,itemId,productKey,
  ownerUid:owner,salesCode:'S01',qty:3,toWarehouseId:custody,deliveryPlan:handoffPlan,
  reservationLocationSchemaVersion:2,custodyLocationSchemaVersion:3,lifecycleWarehouseIds:['A','B'],
  sourceLocations:[{warehouseId:'A',qty:3}],orderTransferIntentHash:'handoff-sha',
  allocations:[{lotId:'ORIGINAL',targetLotId:'HANDOFF-0',qty:3,costLotId:'ORIGINAL'}]};
 put('stockTransfers/HANDOFF',transfer);
 put('reservationOperationReceipts/order-transfer-dispatch-HANDOFF',{
  kind:'ORDER_TRANSFER_DISPATCH',intentHash:'handoff-sha',transfer});
 put('inventoryMovements/HANDOFF-in',{type:'warehouse_transfer_in',sourceType:'WAREHOUSE_TRANSFER',
  sourceId:transferId,warehouseId:custody,orderId,itemId,productKey,qty:3});
 put('inventoryLots/HANDOFF-0',{productKey,warehouseId:custody,sourceId:transferId,transferId,
  sourceType:'WAREHOUSE_TRANSFER',qty:3,remainingQty:3,costLotId:'ORIGINAL',lotNo:'LOT-01'});
 put('inventoryLotCosts/HANDOFF-0',{productKey,warehouseId:custody,sourceId:transferId,
  costSourceLotId:'ORIGINAL',unitCost:218});
 let failCreate='',writes=0;
 const db={projectId:'demo-yushin',collection(name){return{
  doc(id){return{id,path:name+'/'+id};},
  where(field,operator,value){return{
   where(field2,operator2,value2){return{limit(max){return{query:{name,field,operator,value,field2,operator2,value2,max}};}};},
   limit(max){return{query:{name,field,operator,value,max}};}
  };}
 };},async runTransaction(fn){
  const pending=[];
  const tx={async get(target){
   if(target.query){const q=target.query;const rows=[...docs].filter(([path,data])=>path.startsWith(q.name+'/')
    &&data[q.field]===q.value&&(!q.field2||data[q.field2]===q.value2)).slice(0,q.max);
    return{size:rows.length,empty:!rows.length,docs:rows.map(([path,data])=>({id:path.split('/')[1],data:()=>clone(data)}))};}
   const data=docs.get(target.path);return{exists:data!==undefined,data:()=>clone(data)};
  },update(ref,data){pending.push({ref,data:clone(data),create:false});},
  set(ref,data){pending.push({ref,data:clone(data),create:false});},
  create(ref,data){pending.push({ref,data:clone(data),create:true});}};
  const result=await fn(tx),next=new Map([...docs].map(([key,value])=>[key,clone(value)]));
  for(const row of pending){
   if(row.create&&(next.has(row.ref.path)||row.ref.path===failCreate))throw Error('create collision');
   if(!row.create&&!next.has(row.ref.path))throw Error('missing update source');
   next.set(row.ref.path,{...(next.get(row.ref.path)||{}),...row.data});
  }
  docs.clear();for(const [path,data] of next)docs.set(path,data);
  writes+=pending.length;
  return result;
 }};
 const input=(operationId,quantity=1)=>({orderId,itemId,warehouseId:custody,quantity,date:'2026-10-29',
  notes:'發貨給客戶',operationId,syncAttemptId:'sync_123456789',
  expectedPlan:{mode:'CUSTOMER_SHIP',contact:'客戶甲',phone:'0223456789',
   address:'測試專用收件位置',warehouseId:'',packages:1,notes:''}});
 return{db,docs,put,input,read:path=>clone(docs.get(path)),snapshot:()=>clone(Object.fromEntries(docs)),
  writes:()=>writes,failCreate:path=>{failCreate=path;}};
}
function multiFixture(){
 const f=fixture(),order=f.read('orders/ORDER'),owner='SALES',custody='custody-SALES';
 const transferId='HANDOFF-J',itemId='J',productKey='Q',handoffPlan=f.read('stockTransfers/HANDOFF').deliveryPlan;
 f.put('orders/ORDER',{...order,items:[...order.items,{
  itemId,qty:2,productId:productKey,warehouseId:custody,custodyTransferId:transferId,
  deliveryPlan:handoffPlan,reservedQty:2,shortageQty:0,dispatchPreparedQty:2,
  warehouseShippedQty:0,deliveredQty:0,returnedQty:0}]});
 f.put('products/Q',{active:true,productType:'Goods'});
 f.put('inventory/Q',{productKey,onHand:3,reserved:2});
 f.put('warehouseStocks/'+custody+'__Q',{productKey,warehouseId:custody,onHand:2,reserved:2});
 f.put('inventoryReservations/ORDER__J',{orderId:'ORDER',itemId,productKey,ownerUid:owner,salesCode:'S01',
  locationSchemaVersion:3,quantity:2,shortageQty:0,status:'active',
  locations:[{warehouseId:custody,reservedQty:2}],lifecycleWarehouseIds:['A','B'],
  sourceLocationSnapshot:[{warehouseId:'A',reservedQty:2}],custodyOriginalQty:2,custodyTransferId:transferId});
 const transfer={id:transferId,kind:'HANDOFF',status:'RECEIVED',orderId:'ORDER',itemId,productKey,
  ownerUid:owner,salesCode:'S01',qty:2,toWarehouseId:custody,deliveryPlan:handoffPlan,
  reservationLocationSchemaVersion:2,custodyLocationSchemaVersion:3,lifecycleWarehouseIds:['A','B'],
  sourceLocations:[{warehouseId:'A',qty:2}],orderTransferIntentHash:'handoff-j-sha',
  allocations:[{lotId:'ORIGINAL-J',targetLotId:'HANDOFF-J-0',qty:2,costLotId:'ORIGINAL-J'}]};
 f.put('stockTransfers/HANDOFF-J',transfer);
 f.put('reservationOperationReceipts/order-transfer-dispatch-HANDOFF-J',{
  kind:'ORDER_TRANSFER_DISPATCH',intentHash:'handoff-j-sha',transfer});
 f.put('inventoryMovements/HANDOFF-J-in',{type:'warehouse_transfer_in',sourceType:'WAREHOUSE_TRANSFER',
  sourceId:transferId,warehouseId:custody,orderId:'ORDER',itemId,productKey,qty:2});
 f.put('inventoryLots/HANDOFF-J-0',{productKey,warehouseId:custody,sourceId:transferId,transferId,
  sourceType:'WAREHOUSE_TRANSFER',qty:2,remainingQty:2,costLotId:'ORIGINAL-J',lotNo:'LOT-02'});
 f.put('inventoryLotCosts/HANDOFF-J-0',{productKey,warehouseId:custody,sourceId:transferId,
  costSourceLotId:'ORIGINAL-J',unitCost:390});
 const originalInput=f.input;
 f.itemInput=(itemId,operationId,quantity=1)=>({...originalInput(operationId,quantity),itemId});
 return f;
}
test('V3 Custody shipment gate is demo Auth/Functions/Firestore Emulator only',()=>{
 assert.equal(custodyShipmentProject({}),'');
 assert.equal(custodyShipmentProject({...env,GCLOUD_PROJECT:'production'}),'');
 assert.equal(custodyShipmentProject({...env,FIREBASE_AUTH_EMULATOR_HOST:'remote:9099'}),'');
 assert.equal(custodyShipmentProject({...env,FUNCTIONS_EMULATOR:'false'}),'');
 assert.equal(custodyShipmentProject(env),'demo-yushin');
});
test('real V3 source and the shared issue core partially ship, replay and finish without delivery or cost rewrite',async()=>{
 const f=fixture(),initialCost=f.read('inventoryLotCosts/HANDOFF-0'),original=f.read('stockTransfers/HANDOFF');
 const first=f.input('custody_ship_1234567',1);
 const result=await commitCustodyShipment(f.db,'SALES',first,env);
 assert.equal(result.status,'applied');
 assert.equal(f.read('inventory/P').onHand,4);
 assert.equal(f.read('inventory/P').reserved,3);
 assert.equal(f.read('warehouseStocks/custody-SALES__P').onHand,2);
 assert.equal(f.read('warehouseStocks/custody-SALES__P').reserved,2);
 assert.equal(f.read('inventoryReservations/ORDER__I').quantity,2);
 assert.equal(f.read('inventoryReservations/ORDER__I').custodyOriginalQty,3);
 assert.equal(f.read('inventoryLots/HANDOFF-0').remainingQty,2);
 assert.deepEqual(f.read('inventoryLotCosts/HANDOFF-0'),initialCost);
 assert.deepEqual(f.read('stockTransfers/HANDOFF'),original);
 const firstRecord=f.read('orders/ORDER').warehouseShipmentRecords[0];
 assert.equal(firstRecord.custodyTransferId,'HANDOFF');
 assert.equal(firstRecord.lotAllocations[0].costLotId,'ORIGINAL');
 assert.equal(f.read('orders/ORDER').deliveredQty,0);
 assert.deepEqual(f.read('orders/ORDER').deliveryRecords,[]);
 const snapshot=f.snapshot(),replay=await commitCustodyShipment(f.db,'SALES',first,env);
 assert.equal(replay.status,'already-applied');assert.deepEqual(f.snapshot(),snapshot);
 const last=await commitCustodyShipment(f.db,'SALES',f.input('custody_ship_7654321',2),env);
 assert.equal(last.status,'applied');
 assert.equal(f.read('inventory/P').onHand,2);assert.equal(f.read('inventory/P').reserved,1);
 assert.equal(f.read('warehouseStocks/custody-SALES__P').onHand,0);
 assert.equal(f.read('warehouseStocks/custody-SALES__P').reserved,0);
 assert.equal(f.read('inventoryReservations/ORDER__I').status,'fulfilled');
 assert.equal(f.read('orders/ORDER').items[0].warehouseShippedQty,3);
 assert.equal(f.read('orders/ORDER').isDelivered,false);
});
test('V3 Custody rejects forged owner, role, handoff, lot cost, exhausted stock and changed payload without partial writes',async()=>{
 const scenarios=[
  ['wrong-owner',f=>({actor:'OTHER'})],
  ['wrong-role',f=>{f.put('users/SALES',{role:'warehouse',active:true});}],
  ['wrong-handoff',f=>{f.put('stockTransfers/HANDOFF',{...f.read('stockTransfers/HANDOFF'),qty:4});}],
  ['missing-handoff',f=>f.docs.delete('inventoryMovements/HANDOFF-in')],
  ['wrong-cost',f=>{f.put('inventoryLotCosts/HANDOFF-0',{costSourceLotId:'OTHER'});} ],
  ['wrong-lot',f=>{f.put('inventoryLots/HANDOFF-0',{...f.read('inventoryLots/HANDOFF-0'),costLotId:'OTHER'});} ],
  ['company-shortage',f=>{f.put('inventory/P',{productKey:'P',onHand:2,reserved:4});}],
  ['warehouse-shortage',f=>{f.put('warehouseStocks/custody-SALES__P',{productKey:'P',warehouseId:'custody-SALES',onHand:1,reserved:3});}],
  ['cancelled',f=>{f.put('orders/ORDER',{...f.read('orders/ORDER'),orderStatus:'cancelled'});} ],
 ];
 for(const [name,setup] of scenarios){
  const f=fixture(),opts=setup(f)||{},before=f.snapshot();
  await assert.rejects(commitCustodyShipment(f.db,opts.actor||'SALES',f.input('custody_guard_1234567'),env),name);
  assert.deepEqual(f.snapshot(),before,name+' must be atomic and read-only');
 }
 const f=fixture(),input=f.input('custody_shipment_replay');
 await commitCustodyShipment(f.db,'SALES',input,env);
 const before=f.snapshot();
 await assert.rejects(commitCustodyShipment(f.db,'SALES',{...input,notes:'另一個客戶'},env),e=>e.code==='already-exists');
 assert.deepEqual(f.snapshot(),before);
 await assert.rejects(commitCustodyShipment(f.db,'SALES',f.input('custody_ship_overflow',4),env));
 assert.deepEqual(f.snapshot(),before);
});
test('V3 Custody transaction keeps all writes atomic when immutable movement ID collides',async()=>{
 const f=fixture(),before=f.snapshot();
 f.failCreate('inventoryMovements/location-ship-custody_collision_123');
 await assert.rejects(commitCustodyShipment(f.db,'SALES',f.input('custody_collision_123'),env));
 assert.deepEqual(f.snapshot(),before);
});
test('V3 Custody 2-line shipment preserves sibling rows, provenance and exact operation replay',async()=>{
 const f=multiFixture(),beforeJCost=f.read('inventoryLotCosts/HANDOFF-J-0');
 const j=f.itemInput('J','custody_multi_j_first',1);
 const first=await commitCustodyShipment(f.db,'SALES',j,env);
 assert.equal(first.status,'applied');
 let order=f.read('orders/ORDER');
 assert.equal(order.items.length,2);
 assert.equal(order.items[0].reservedQty,3);
 assert.equal(order.items[1].reservedQty,1);
 assert.equal(order.warehouseShipmentRecords[0].itemIndex,1);
 assert.equal(order.warehouseShipmentRecords[0].itemId,'J');
 assert.equal(f.read('inventory/P').onHand,5);
 assert.equal(f.read('inventory/Q').onHand,2);
 assert.equal(f.read('warehouseStocks/custody-SALES__Q').reserved,1);
 assert.equal(f.read('inventoryReservations/ORDER__J').quantity,1);
 assert.equal(f.read('inventoryLots/HANDOFF-J-0').remainingQty,1);
 assert.deepEqual(f.read('inventoryLotCosts/HANDOFF-J-0'),beforeJCost);
 const snapshot=f.snapshot();
 assert.equal((await commitCustodyShipment(f.db,'SALES',j,env)).status,'already-applied');
 assert.deepEqual(f.snapshot(),snapshot);
 await commitCustodyShipment(f.db,'SALES',f.itemInput('I','custody_multi_i_first'),env);
 order=f.read('orders/ORDER');
 assert.equal(order.items.length,2);
 assert.equal(order.items[0].warehouseShippedQty,1);
 assert.equal(order.items[1].warehouseShippedQty,1);
 assert.deepEqual(order.warehouseShipmentRecords.map(row=>row.itemId),['J','I']);
 assert.equal(f.read('inventory/P').onHand,4);
 assert.equal(f.read('inventory/Q').onHand,2);
 await commitCustodyShipment(f.db,'SALES',f.itemInput('J','custody_multi_j_last'),env);
 assert.equal(f.read('orders/ORDER').items[1].reservedQty,0);
 assert.equal(f.read('inventoryReservations/ORDER__J').status,'fulfilled');
 assert.equal(f.read('orders/ORDER').items[0].reservedQty,2);
 assert.equal(f.read('orders/ORDER').deliveredQty,0);
 assert.deepEqual(f.read('orders/ORDER').deliveryRecords,[]);
});
test('V3 Custody 2-line shipment rejects sibling corruption and cross-item reused IDs without writing',async()=>{
 const f=multiFixture();
 const j=f.itemInput('J','custody_multi_guard_j');
 await commitCustodyShipment(f.db,'SALES',j,env);
 const snapshot=f.snapshot();
 await assert.rejects(commitCustodyShipment(f.db,'SALES',f.itemInput('I','custody_multi_guard_j'),env),
  e=>e.code==='already-exists');
 assert.deepEqual(f.snapshot(),snapshot);
 f.docs.delete('inventoryMovements/location-ship-custody_multi_guard_j');
 const beforeMissing=f.snapshot();
 await assert.rejects(commitCustodyShipment(f.db,'SALES',f.itemInput('I','custody_multi_guard_i'),env));
 assert.deepEqual(f.snapshot(),beforeMissing);
 const fresh=multiFixture(),source=fresh.read('orders/ORDER');
 fresh.put('orders/ORDER',{...source,items:source.items.map(row=>row.itemId==='J'?{
  ...row,warehouseShippedQty:1}:row)});
 const beforeForged=fresh.snapshot();
 await assert.rejects(commitCustodyShipment(fresh.db,'SALES',fresh.itemInput('I','custody_multi_guard_bad'),env));
 assert.deepEqual(fresh.snapshot(),beforeForged);
 const over=multiFixture(),original=over.read('orders/ORDER');
 over.put('orders/ORDER',{...original,items:[...original.items,...Array.from({length:4},(_,i)=>({
  ...original.items[1],itemId:'MORE-'+i}))]});
 const beforeOver=over.snapshot();
 await assert.rejects(commitCustodyShipment(over.db,'SALES',over.itemInput('I','custody_multi_too_many'),env));
 assert.deepEqual(over.snapshot(),beforeOver);
 const service=multiFixture(),serviceOrder=service.read('orders/ORDER');
 service.put('orders/ORDER',{...serviceOrder,items:serviceOrder.items.map(row=>row.itemId==='J'?{
  ...row,productType:'SERVICE'}:row)});
 const beforeService=service.snapshot();
 await assert.rejects(commitCustodyShipment(service.db,'SALES',service.itemInput('I','custody_multi_service'),env));
 assert.deepEqual(service.snapshot(),beforeService);
});
test('V3 Custody 2-line customer acknowledgement updates only commercial progress, preserving all stock and lots',async()=>{
 const f=multiFixture();
 const shipmentJ=f.itemInput('J','custody_multi_ack_j_ship',2);
 const shipmentI=f.itemInput('I','custody_multi_ack_i_ship',3);
 await commitCustodyShipment(f.db,'SALES',shipmentJ,env);
 await commitCustodyShipment(f.db,'SALES',shipmentI,env);
 const deliveryEnv={...env,ENABLE_V3_CUSTODY_DELIVERY_EMULATOR:'true'};
 const intent=(itemId,shipmentId,operationId,quantity)=>({orderId:'ORDER',itemId,shipmentId,
  operationId,quantity,date:'2026-10-30',notes:'客戶簽收',syncAttemptId:'sync_123456789'});
 const beforeStocks=['inventory/P','inventory/Q','warehouseStocks/custody-SALES__P',
  'warehouseStocks/custody-SALES__Q','inventoryLots/HANDOFF-0','inventoryLots/HANDOFF-J-0',
  'inventoryLotCosts/HANDOFF-0','inventoryLotCosts/HANDOFF-J-0'].map(key=>[key,f.read(key)]);
 const j=intent('J',shipmentJ.operationId,'custody_multi_ack_j_delivery',2);
 const deliveredJ=await commitCustodyDelivery(f.db,'SALES',j,deliveryEnv);
 assert.equal(deliveredJ.status,'applied');
 assert.equal(deliveredJ.itemIsDelivered,true);
 assert.equal(deliveredJ.isDelivered,false);
 assert.deepEqual(f.read('orders/ORDER').items.map(row=>row.deliveredQty??0),[0,2]);
 const snapshot=f.snapshot();
 assert.equal((await commitCustodyDelivery(f.db,'SALES',j,deliveryEnv)).status,'already-applied');
 assert.deepEqual(f.snapshot(),snapshot);
 const deliveredI=await commitCustodyDelivery(f.db,'SALES',
  intent('I',shipmentI.operationId,'custody_multi_ack_i_delivery',3),deliveryEnv);
 assert.equal(deliveredI.itemIsDelivered,true);
 assert.equal(deliveredI.isDelivered,true);
 const order=f.read('orders/ORDER');
 assert.equal(order.deliveredQty,5);
 assert.equal(order.isDelivered,true);
 assert.deepEqual(order.items.map(row=>row.deliveredQty),[3,2]);
 for(const [key,original] of beforeStocks)assert.deepEqual(f.read(key),original,key+' is unchanged');
});
test('V3 multi-line delivery cannot use V2 entry or conceal a forged sibling shipment',async()=>{
 const f=multiFixture();
 const shipmentJ=f.itemInput('J','custody_multi_proof_j_ship');
 const shipmentI=f.itemInput('I','custody_multi_proof_i_ship');
 await commitCustodyShipment(f.db,'SALES',shipmentJ,env);
 await commitCustodyShipment(f.db,'SALES',shipmentI,env);
 const intent={orderId:'ORDER',itemId:'I',shipmentId:shipmentI.operationId,
  operationId:'custody_multi_proof_i_ack',quantity:1,date:'2026-10-30',
  notes:'客戶簽收',syncAttemptId:'sync_123456789'};
 const deliveryEnv={...env,ENABLE_V3_CUSTODY_DELIVERY_EMULATOR:'true'};
 const before=f.snapshot();
 await assert.rejects(commitShipmentDelivery(f.db,'SALES',intent,deliveryEnv));
 assert.deepEqual(f.snapshot(),before);
 f.put('inventoryMovements/location-ship-'+shipmentJ.operationId,{
  ...f.read('inventoryMovements/location-ship-'+shipmentJ.operationId),custodyTransferId:'FORGED'});
 const tampered=f.snapshot();
 await assert.rejects(commitCustodyDelivery(f.db,'SALES',intent,deliveryEnv));
 assert.deepEqual(f.snapshot(),tampered);
});
test('V3 Custody 2-line CLOSE return restores exactly the selected provenance lot without sibling writes',async()=>{
 const f=multiFixture();
 const shipmentJ=f.itemInput('J','custody_multi_return_j_ship');
 const shipmentI=f.itemInput('I','custody_multi_return_i_ship');
 await commitCustodyShipment(f.db,'SALES',shipmentJ,env);
 await commitCustodyShipment(f.db,'SALES',shipmentI,env);
 await commitCustodyDelivery(f.db,'SALES',{orderId:'ORDER',itemId:'J',shipmentId:shipmentJ.operationId,
  operationId:'custody_multi_return_j_ack',quantity:1,date:'2026-10-30',notes:'客戶簽收',
  syncAttemptId:'sync_123456789'},{...env,ENABLE_V3_CUSTODY_DELIVERY_EMULATOR:'true'});
 const originalP=['inventory/P','warehouseStocks/custody-SALES__P','inventoryReservations/ORDER__I',
  'inventoryLots/HANDOFF-0','inventoryLotCosts/HANDOFF-0'].map(key=>[key,f.read(key)]);
 const originalCostJ=f.read('inventoryLotCosts/HANDOFF-J-0');
 const ret={orderId:'ORDER',itemId:'J',shipmentId:shipmentJ.operationId,
  operationId:'custody_multi_return_j_receipt',warehouseId:'custody-SALES',date:'2026-10-30',
  reason:'客戶退回原批次',condition:'RESTOCKABLE',settlement:'CLOSE',
  syncAttemptId:'sync_123456789',selections:[{lotId:'HANDOFF-J-0',qty:1}]};
 const returnEnv={...env,ENABLE_V3_CUSTODY_RETURN_EMULATOR:'true'};
 const result=await commitCustodyReturn(f.db,'SALES',ret,returnEnv);
 assert.equal(result.status,'applied');
 assert.equal(result.qty,1);
 assert.equal(result.settlement,'CLOSE');
 assert.equal(f.read('inventory/Q').onHand,3);
 assert.equal(f.read('warehouseStocks/custody-SALES__Q').onHand,2);
 assert.equal(f.read('inventoryLots/HANDOFF-J-0').remainingQty,2);
 assert.equal(f.read('inventoryReservations/ORDER__J').quantity,1);
 assert.deepEqual(f.read('inventoryLotCosts/HANDOFF-J-0'),originalCostJ);
 assert.equal(f.read('orders/ORDER').returnRecords[0].itemId,'J');
 assert.equal(f.read('orders/ORDER').returnedQty,1);
 assert.equal(f.read('orders/ORDER').items[0].returnedQty??0,0);
 for(const [key,original] of originalP)assert.deepEqual(f.read(key),original,key+' unchanged');
 const snapshot=f.snapshot();
 assert.equal((await commitCustodyReturn(f.db,'SALES',ret,returnEnv)).status,'already-applied');
 assert.deepEqual(f.snapshot(),snapshot);
});
test('V3 Custody multi-line return rejects a forged sibling reservation and REPLACE without partial restoration',async()=>{
 const f=multiFixture(),shipment=f.itemInput('J','custody_multi_guard_return_ship');
 await commitCustodyShipment(f.db,'SALES',shipment,env);
 await commitCustodyDelivery(f.db,'SALES',{orderId:'ORDER',itemId:'J',shipmentId:shipment.operationId,
  operationId:'custody_multi_guard_return_ack',quantity:1,date:'2026-10-30',notes:'簽收',
  syncAttemptId:'sync_123456789'},{...env,ENABLE_V3_CUSTODY_DELIVERY_EMULATOR:'true'});
 const ret={orderId:'ORDER',itemId:'J',shipmentId:shipment.operationId,
  operationId:'custody_multi_guard_return_rec',warehouseId:'custody-SALES',date:'2026-10-30',
  reason:'原批次退貨',condition:'RESTOCKABLE',settlement:'CLOSE',
  syncAttemptId:'sync_123456789',selections:[{lotId:'HANDOFF-J-0',qty:1}]};
 const returnEnv={...env,ENABLE_V3_CUSTODY_RETURN_EMULATOR:'true'};
 const prior=f.snapshot();
 await assert.rejects(commitCustodyReturn(f.db,'SALES',{...ret,settlement:'REPLACE'},returnEnv));
 assert.deepEqual(f.snapshot(),prior);
 f.put('inventoryReservations/ORDER__I',{
  ...f.read('inventoryReservations/ORDER__I'),quantity:1});
 const forged=f.snapshot();
 await assert.rejects(commitCustodyReturn(f.db,'SALES',ret,returnEnv));
 assert.deepEqual(f.snapshot(),forged);
});
