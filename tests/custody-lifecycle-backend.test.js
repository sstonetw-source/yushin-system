'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {custodyLifecycleProject,custodyLifecycleIntent,commitCustodyOrderLifecycle}=require('../functions/custody-lifecycle-service');
const env={GCLOUD_PROJECT:'demo-yushin',FUNCTIONS_EMULATOR:'true',
 FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099',
 ENABLE_V3_CUSTODY_LIFECYCLE_EMULATOR:'true'};
function fixture(){
 const docs=new Map(),clone=x=>structuredClone(x),put=(path,data)=>docs.set(path,clone(data));
 const owner='SALES',custodyId='custody-'+owner,productKey='P',orderId='ORDER';
 const ref=(name,id)=>({id,path:name+'/'+id});
 put('users/SALES',{role:'sales',active:true});put('users/ADMIN',{role:'admin',active:true});
 put('users/OTHER',{role:'sales',active:true});put('products/P',{active:true,productType:'Goods'});
 put('warehouses/'+custodyId,{active:true,systemCustody:true,ownerUid:owner});
 put('inventory/P',{productKey,onHand:10,reserved:5});
 put('warehouseStocks/'+custodyId+'__P',{warehouseId:custodyId,productKey,onHand:5,reserved:3});
 const items=[];
 for(const [itemId,requested,transferId] of [['I1',1,'T1'],['I2',2,'T2']]){
  items.push({itemId,productId:'P',qty:requested,reservedQty:requested,shortageQty:0,
   warehouseId:custodyId,custodyTransferId:transferId});
  put('inventoryReservations/'+orderId+'__'+itemId,{orderId,itemId,productKey,ownerUid:owner,
   salesCode:'S01',locationSchemaVersion:3,lifecycleWarehouseIds:['A','B'],
   sourceLocationSnapshot:[{warehouseId:'A',reservedQty:requested}],custodyOriginalQty:requested,
   custodyTransferId:transferId,quantity:requested,shortageQty:0,status:'active',
   locations:[{warehouseId:custodyId,reservedQty:requested}]});
  const transfer={id:transferId,kind:'HANDOFF',status:'RECEIVED',orderId,itemId,
   qty:requested,ownerUid:owner,salesCode:'S01',toWarehouseId:custodyId,
   productKey,orderTransferIntentHash:'hash-'+transferId,reservationLocationSchemaVersion:2,
   custodyLocationSchemaVersion:3,lifecycleWarehouseIds:['A','B'],
   sourceLocations:[{warehouseId:'A',qty:requested}]};
  put('stockTransfers/'+transferId,transfer);
  put('reservationOperationReceipts/order-transfer-dispatch-'+transferId,{
   kind:'ORDER_TRANSFER_DISPATCH',intentHash:'hash-'+transferId,transfer});
  put('inventoryMovements/'+transferId+'-in',{
   type:'warehouse_transfer_in',sourceType:'WAREHOUSE_TRANSFER',sourceId:transferId,
   orderId,itemId,productKey,warehouseId:custodyId,qty:requested});
 }
 put('orders/ORDER',{status:'active',orderStatus:'normal',inventoryReservationStatus:'completed',
  inventoryReservationAttemptId:'sync_1234567890',ownerUid:owner,salesCode:'S01',items,
  orderLifecycleHistory:[],logisticsTransfersPending:0});
 let failAtCreate='',commits=0;
 const db={projectId:'demo-yushin',
  collection(name){return{
   doc(id){return ref(name,id);},
   where(field,operator,value){return{limit(max){return{_query:{name,field,operator,value,max}};}};}
  };},
  async runTransaction(callback){
   const writes=[];
   const tx={
    async get(input){
     if(input._query){const q=input._query,entries=[...docs].filter(([path,data])=>path.startsWith(q.name+'/')&&data[q.field]===q.value).slice(0,q.max);
      return{empty:entries.length===0,docs:entries.map(([path,data])=>({id:path.split('/')[1],data:()=>clone(data)}))};}
     const data=docs.get(input.path);return{exists:!!data,data:()=>clone(data)};
    },
    update(target,data){writes.push({kind:'update',target,data:clone(data)});},
    create(target,data){writes.push({kind:'create',target,data:clone(data)});}
   };
   const result=await callback(tx),next=new Map([...docs].map(([key,value])=>[key,clone(value)]));
   for(const write of writes){
    if(write.kind==='create'&&(next.has(write.target.path)||write.target.path===failAtCreate))throw Error('atomic collision');
    if(write.kind==='update'&&!next.has(write.target.path))throw Error('missing update source');
    next.set(write.target.path,{...(next.get(write.target.path)||{}),...write.data});
   }
   docs.clear();for(const [key,value] of next)docs.set(key,value);
   commits++;return result;
  }};
 const input=(operationId,nextStatus)=>({orderId,itemIds:['I2','I1'],
  operationId,syncAttemptId:'sync_1234567890',nextStatus,date:'2026-10-29',reason:'Test'});
 return{db,docs,put,read:path=>clone(docs.get(path)),input,commits:()=>commits,
  failCreate:path=>{failAtCreate=path;},snapshot:()=>clone(Object.fromEntries(docs))};
}
test('custody Callable gate is default closed and bound to demo Auth/Functions/Firestore',()=>{
 assert.equal(custodyLifecycleProject({}), '');
 assert.equal(custodyLifecycleProject({...env,GCLOUD_PROJECT:'live-project'}),'');
 assert.equal(custodyLifecycleProject({...env,FIREBASE_AUTH_EMULATOR_HOST:'remote:9099'}),'');
 assert.equal(custodyLifecycleProject({...env,ENABLE_V3_CUSTODY_LIFECYCLE_EMULATOR:'false'}),'');
 assert.equal(custodyLifecycleProject(env),'demo-yushin');
});
test('strict request normalizes stable item identity but rejects unauthorized fields and duplicates',()=>{
 const f=fixture(),a=custodyLifecycleIntent(f.input('life_1234567890','cancelled'));
 assert.deepEqual(a.itemIds,['I1','I2']);
 assert.equal(a.hash,custodyLifecycleIntent({...f.input('life_1234567890','cancelled'),itemIds:['I1','I2']}).hash);
 for(const changes of [{itemIds:['I1','I1']},{itemIds:[]},{extra:true},
  {operationId:'short'},{date:'2026-02-30'},{nextStatus:'closed'}])
  assert.throws(()=>custodyLifecycleIntent({...f.input('life_1234567890','cancelled'),...changes}));
});
test('whole-order V3 custody cancel, restore and replay preserve company/warehouse source and audit history',async()=>{
 const f=fixture(),cancel=f.input('life_cancel_123456','cancelled');
 const before=f.snapshot(),first=await commitCustodyOrderLifecycle(f.db,'SALES',cancel,env);
 assert.equal(first.status,'applied');assert.equal(f.read('inventory/P').reserved,2);
 assert.equal(f.read('warehouseStocks/custody-SALES__P').reserved,0);
 for(const [itemId,original] of [['I1',1],['I2',2]]){
  const ledger=f.read('inventoryReservations/ORDER__'+itemId);
  assert.equal(ledger.quantity,0);assert.deepEqual(ledger.locations,[]);
  assert.deepEqual(ledger.sourceLocationSnapshot,[{warehouseId:'A',reservedQty:original}]);
  assert.equal(ledger.custodyOriginalQty,original);
  assert.equal(f.read('inventoryMovements/v3-custody-life-life_cancel_123456-'+itemId).qty,-original);
 }
 assert.equal(f.read('orders/ORDER').orderStatus,'cancelled');
 assert.equal((await commitCustodyOrderLifecycle(f.db,'SALES',cancel,env)).status,'already-applied');
 assert.equal(f.commits(),2,'read-only idempotent replay makes no document changes');
 const restore=f.input('life_restore_123456','normal');
 assert.equal((await commitCustodyOrderLifecycle(f.db,'SALES',restore,env)).status,'applied');
 assert.equal(f.read('inventory/P').reserved,5);
 assert.equal(f.read('warehouseStocks/custody-SALES__P').reserved,3);
 assert.equal(f.read('orders/ORDER').orderLifecycleHistory.length,2);
 assert.equal(f.read('orders/ORDER').orderStatus,'normal');
 assert.deepEqual(f.read('stockTransfers/T1'),before['stockTransfers/T1']);
 assert.deepEqual(f.read('stockTransfers/T2'),before['stockTransfers/T2']);
 assert.equal((await commitCustodyOrderLifecycle(f.db,'SALES',cancel,env)).status,'already-applied');
 assert.equal(f.read('orders/ORDER').orderStatus,'normal','old receipt must not rewind a later restoration');
});
test('role, owner, forged handoff, insufficient stock and late collision leave all data unchanged',async()=>{
 const mutate=[
  f=>f.put('users/SALES',{role:'warehouse',active:true}),
  f=>f.put('orders/ORDER',{...f.read('orders/ORDER'),ownerUid:'OTHER'}),
  f=>f.put('stockTransfers/T1',{...f.read('stockTransfers/T1'),toWarehouseId:'A'}),
  f=>f.put('inventory/P',{...f.read('inventory/P'),reserved:1}),
  f=>f.put('warehouseStocks/custody-SALES__P',{...f.read('warehouseStocks/custody-SALES__P'),reserved:1}),
  f=>f.put('orders/ORDER',{...f.read('orders/ORDER'),warehouseShipmentRecords:[{id:'S'}]})
 ];
 for(const change of mutate){
  const f=fixture();change(f);const before=f.snapshot();
  await assert.rejects(commitCustodyOrderLifecycle(f.db,'SALES',f.input('life_cancel_123456','cancelled'),env));
  assert.deepEqual(f.snapshot(),before);
 }
 const f=fixture();f.failCreate('inventoryMovements/v3-custody-life-life_cancel_123456-I2');
 const before=f.snapshot();await assert.rejects(commitCustodyOrderLifecycle(f.db,'SALES',f.input('life_cancel_123456','cancelled'),env));
 assert.deepEqual(f.snapshot(),before);
 const off=fixture();const initial=off.snapshot();
 await assert.rejects(commitCustodyOrderLifecycle(off.db,'SALES',off.input('life_cancel_123456','cancelled'),{...env,ENABLE_V3_CUSTODY_LIFECYCLE_EMULATOR:'false'}));
 assert.deepEqual(off.snapshot(),initial);
});
test('no V3 custody trial may cancel an order with supplier progress',async()=>{
 const f=fixture();f.put('supplyOrders/SUP',{orderId:'ORDER',itemId:'I1'});
 const before=f.snapshot();await assert.rejects(commitCustodyOrderLifecycle(f.db,'SALES',f.input('life_cancel_123456','cancelled'),env),/採購承諾/);
 assert.deepEqual(f.snapshot(),before);
 const hidden=fixture();hidden.put('receipts/HIDDEN',{
  demandId:'SALES_ORDER:ORDER:I1',itemId:'I1',qty:1});
 const snapshot=hidden.snapshot();
 await assert.rejects(commitCustodyOrderLifecycle(hidden.db,'SALES',hidden.input('life_cancel_123456','cancelled'),env));
 assert.deepEqual(hidden.snapshot(),snapshot);
});
