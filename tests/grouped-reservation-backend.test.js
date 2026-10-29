'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {commitGroupedWarehouseReservation,normalizeIntent}=require('../functions/grouped-reservation-service');
const reservation=require('../modules/reservation-core');

function copy(value){return value===undefined?undefined:structuredClone(value);}
function memoryDb(){
  const docs=new Map();
  const reference=(collection,id)=>({path:collection+'/'+id,id});
  const db={
    docs,
    collection(name){return {doc(id){return reference(name,id)}};},
    async runTransaction(callback){
      const changes=[],reads=new Map();
      const tx={
        async get(ref){
          if(changes.length)throw Error('Read after write: '+ref.path);
          const value=docs.get(ref.path);
          reads.set(ref.path,true);
          return {exists:value!==undefined,data:()=>copy(value)};
        },
        update(ref,data){changes.push({type:'update',path:ref.path,data:copy(data)});},
        set(ref,data,opts){changes.push({type:'set',path:ref.path,data:copy(data),opts});},
        create(ref,data){changes.push({type:'create',path:ref.path,data:copy(data)});}
      };
      const result=await callback(tx);
      const next=new Map([...docs].map(([k,v])=>[k,copy(v)]));
      for(const change of changes){
        if(change.type==='create'&&next.has(change.path))
          throw Error('Already created '+change.path);
        if(change.type==='update'&&!next.has(change.path))
          throw Error('Cannot update missing '+change.path);
        next.set(change.path,{...(change.type==='update'||change.opts?.merge?next.get(change.path):{}),...change.data});
      }
      docs.clear();
      for(const [path,value] of next)docs.set(path,value);
      return result;
    }
  };
  const set=(path,data)=>docs.set(path,copy(data));
  const snapshot=()=>JSON.stringify([...docs].sort(([a],[b])=>a.localeCompare(b)));
  return {db,docs,set,snapshot};
}
function fixture({role='purchaser',owner='sales1'}={}){
  const f=memoryDb();
  f.set('users/actor',{role,active:true});
  f.set('users/sales1',{role:'sales',active:true});
  f.set('users/off',{role:'purchaser',active:false});
  f.set('orders/O',{ownerUid:owner,salesCode:'S01',status:'active',
    inventoryReservationStatus:'pending',inventoryReservationAttemptId:'sync_1234567890',items:[
    {itemId:'I1',productId:'P',warehouseId:'A',qty:5,reservedQty:0},
    {itemId:'I2',productId:'P',warehouseId:'B',qty:5,reservedQty:0}
  ]});
  f.set('inventory/P',{productKey:'P',onHand:20,reserved:0,transferFreeInTransit:0});
  f.set('products/P',{productId:'P',productType:'Goods',active:true});
  for(const wh of ['A','B']){
    f.set('warehouses/'+wh,{active:true,systemCustody:false});
    f.set('warehouseStocks/'+wh+'__P',{productKey:'P',warehouseId:wh,onHand:10,reserved:0,transferFreeInTransit:0});
  }
  const request=(a=2,b=3,attemptId='attempt_123456789')=>({orderId:'O',attemptId,syncAttemptId:'sync_1234567890',items:[
    {itemId:'I1',quantity:a},{itemId:'I2',quantity:b}
  ]});
  return {...f,request,commit:(data=request(),uid='actor')=>
    commitGroupedWarehouseReservation(f.db,uid,data)};
}
test('grouped reservation uses shared Core, updates company + each warehouse atomically',async()=>{
  const f=fixture();
  const result=await f.commit();
  assert.equal(result.status,'applied');assert.equal(result.companyReservedDelta,5);
  assert.equal(f.docs.get('inventory/P').reserved,5);
  assert.equal(f.docs.get('warehouseStocks/A__P').reserved,2);
  assert.equal(f.docs.get('warehouseStocks/B__P').reserved,3);
  assert.equal(f.docs.get('inventoryReservations/O__I1').quantity,2);
  assert.equal(f.docs.get('inventoryReservations/O__I2').quantity,3);
  assert.equal(f.docs.get('orders/O').items[0].reservedQty,2);
  assert.equal(f.docs.get('orders/O').items[1].shortageQty,2);
  const first={warehouseId:'A',quantity:2};
  assert.equal(reservation.reservationStockDeltas({},first).companyReservedDelta,2);
  const movement=f.docs.get('inventoryMovements/grouped-attempt_123456789-A');
  assert.equal(movement.sourceId,'O');assert.equal(movement.qty,2);
  assert.equal(movement.actorUid,'actor');
  assert.equal(f.docs.get('reservationOperationReceipts/grouped-attempt_123456789').actorRole,'purchaser');
});
test('same attempt replay returns receipt; new attempt with unchanged quantities does not double reserve',async()=>{
  const f=fixture();await f.commit();const baseline=f.snapshot();
  assert.equal((await f.commit()).status,'already-applied');assert.equal(f.snapshot(),baseline);
  const second=await f.commit(f.request(2,3,'another_attempt_12345'));
  assert.equal(second.companyReservedDelta,0);
  assert.equal(f.docs.get('inventory/P').reserved,5);
  assert.equal([...f.docs.keys()].filter(k=>k.startsWith('inventoryMovements/')).length,2);
});
test('same attempt id with altered quantities or a different actor cannot replay',async()=>{
  const f=fixture();await f.commit();const before=f.snapshot();
  await assert.rejects(f.commit(f.request(3,2)),/操作識別碼/);
  await assert.rejects(f.commit(f.request(), 'sales1'),/操作識別碼/);
  assert.equal(f.snapshot(),before);
});
test('release and zero-company warehouse exchanges preserve stock conservation',async()=>{
  const f=fixture();await f.commit();
  const res=await f.commit(f.request(1,4,'another_attempt_12345'));
  assert.equal(res.companyReservedDelta,0);
  assert.deepEqual([f.docs.get('inventory/P').reserved,
    f.docs.get('warehouseStocks/A__P').reserved,f.docs.get('warehouseStocks/B__P').reserved],[5,1,4]);
  await f.commit(f.request(0,0,'third_attempt_123456'));
  assert.deepEqual([f.docs.get('inventory/P').reserved,
    f.docs.get('warehouseStocks/A__P').reserved,f.docs.get('warehouseStocks/B__P').reserved],[0,0,0]);
});
test('bad roles, disabled users and cross-owner business attempts cannot write',async()=>{
  for(const [role,uid,owner] of [['guest','actor','sales1'],['sales','actor','sales1'],
    ['engineer','actor','sales1'],['purchaser','off','sales1']]){
    const f=fixture({role,owner}),before=f.snapshot();
    await assert.rejects(f.commit(f.request(),uid),/權限|帳號|只能操作/);
    assert.equal(f.snapshot(),before);
  }
  for(const role of ['admin','purchaser','warehouse','sales','engineer']){
    const f=fixture({role,owner:role==='sales'||role==='engineer'?'actor':'sales1'});
    await f.commit();assert.equal(f.docs.get('inventory/P').reserved,5);
  }
});
test('stock and incoming balances cannot be fabricated by callers',async()=>{
  const f=fixture();
  for(const patch of [
    {...f.request(),actorRole:'admin'},
    {...f.request(),warehouseId:'C'},
    {...f.request(),companyReserved:0},
    {...f.request(),items:[{itemId:'I1',quantity:1,warehouseId:'B'},{itemId:'I2',quantity:1}]}
  ]){
    const before=f.snapshot();await assert.rejects(f.commit(patch),/未授權/);
    assert.equal(f.snapshot(),before);
  }
});
test('stock insufficiency, negative or corrupt transit fail before any writes',async()=>{
  for(const [path,patch] of [
    ['inventory/P',{onHand:4}],
    ['inventory/P',{reserved:-1}],
    ['inventory/P',{transferFreeInTransit:17}],
    ['warehouseStocks/A__P',{onHand:1}],
    ['warehouseStocks/A__P',{reserved:11}],
    ['warehouseStocks/B__P',{transferFreeInTransit:8}]
  ]){
    const f=fixture();Object.assign(f.docs.get(path),patch);
    const before=f.snapshot();await assert.rejects(f.commit(),/庫存|實貨|既有|預留|途中/);
    assert.equal(f.snapshot(),before);
  }
});
test('source cancellation, delivery overcommit, service orders and in-transit shipments reject',async()=>{
  for(const edit of [
    o=>{o.status='cancelled';},
    o=>{o.items[0].deliveredQty=5;},
    o=>{o.items[0].fulfillmentType='DIRECT_SHIP';},
    o=>{o.items[0].productType='Service';},
    o=>{o.items[0].transferPendingId='X';},
    o=>{o.items[0].dispatchPreparedQty=1;},
    o=>{o.items[0].warehouseShippedQty=1;}
  ]){
    const f=fixture();edit(f.docs.get('orders/O'));const before=f.snapshot();
    await assert.rejects(f.commit(),/已取消|待交付|服務|直送|途中|來源|出貨|已履約/);
    assert.equal(f.snapshot(),before);
  }
});
test('existing reservation mismatches, disabled warehouses and default-closed same warehouse fail closed',async()=>{
  const f=fixture();f.set('inventoryReservations/O__I1',{orderId:'WRONG',productKey:'P',warehouseId:'A',quantity:1});
  let before=f.snapshot();await assert.rejects(f.commit(),/來源與訂單不一致/);assert.equal(f.snapshot(),before);
  const disabled=fixture();disabled.docs.get('warehouses/A').active=false;
  before=disabled.snapshot();await assert.rejects(disabled.commit(),/停用/);assert.equal(disabled.snapshot(),before);
  const third=fixture();third.docs.get('orders/O').items[1].warehouseId='A';
  before=third.snapshot();await assert.rejects(third.commit(),/尚未獨立啟用/);assert.equal(third.snapshot(),before);
});
test('same-warehouse multi-line backend atomically reserves, amends and releases without duplicate movement',async()=>{
  const f=fixture();f.docs.get('orders/O').items[1].warehouseId='A';
  const commit=data=>commitGroupedWarehouseReservation(f.db,'actor',data,{allowSameWarehouse:true});
  const first=await commit(f.request(2,3));
  assert.equal(first.companyReservedDelta,5);
  assert.deepEqual(['inventory/P','warehouseStocks/A__P','warehouseStocks/B__P']
    .map(k=>f.docs.get(k).reserved),[5,5,0]);
  assert.deepEqual(f.docs.get('reservationOperationReceipts/grouped-attempt_123456789').warehouseIds,['A']);
  assert.equal([...f.docs.keys()].filter(k=>k.startsWith('inventoryMovements/')).length,1);
  const snapshot=f.snapshot();
  assert.equal((await commit(f.request())).status,'already-applied');
  assert.equal(f.snapshot(),snapshot);
  await assert.rejects(commit(f.request(3,2)),/操作識別碼/);
  assert.equal(f.snapshot(),snapshot);
  f.docs.get('orders/O').inventoryReservationStatus='completed';
  const amend=(a,b,attemptId)=>({...f.request(a,b,attemptId),mode:'amend'});
  assert.equal((await commit(amend(1,4,'same_amend_exchange_12345'))).companyReservedDelta,0);
  assert.deepEqual(f.docs.get('orders/O').items.map(x=>x.reservedQty),[1,4]);
  assert.equal((await commit(amend(0,0,'same_amend_release_12345'))).companyReservedDelta,-5);
  assert.deepEqual(['inventory/P','warehouseStocks/A__P','warehouseStocks/B__P']
    .map(k=>f.docs.get(k).reserved),[0,0,0]);
  const released=f.snapshot();
  assert.equal((await commit(amend(1,4,'same_amend_exchange_12345'))).status,'already-applied');
  assert.equal(f.snapshot(),released,'old same-warehouse receipt must not restore stock');
});
test('same-warehouse backend fails without any partial write when that warehouse has insufficient stock',async()=>{
  const f=fixture();f.docs.get('orders/O').items[1].warehouseId='A';
  f.docs.get('warehouseStocks/A__P').onHand=4;
  const before=f.snapshot();
  await assert.rejects(commitGroupedWarehouseReservation(f.db,'actor',f.request(),{
    allowSameWarehouse:true}),/庫存不足/);
  assert.equal(f.snapshot(),before);
  assert.equal([...f.docs.keys()].filter(k=>k.startsWith('reservationOperationReceipts/')).length,0);
});
test('operation limit, intent quantities and unknown location ledger are rejected',async()=>{
  for(const input of [
    {orderId:'O',attemptId:'short',syncAttemptId:'sync_1234567890',items:[{itemId:'I1',quantity:1},{itemId:'I2',quantity:2}]},
    {orderId:'O',attemptId:'attempt_123456789',syncAttemptId:'sync_1234567890',items:[{itemId:'I1',quantity:1.3},{itemId:'I2',quantity:2}]},
    {orderId:'O',attemptId:'attempt_123456789',syncAttemptId:'sync_1234567890',items:[{itemId:'I1',quantity:1},{itemId:'I1',quantity:2}]}
  ])assert.throws(()=>normalizeIntent(input),/不正確|整數|重複/);
  const f=fixture();f.set('inventoryReservations/O__I1',{orderId:'O',itemId:'I1',productKey:'P',
    warehouseId:'A',ownerUid:'sales1',salesCode:'S01',quantity:0,locationSchemaVersion:2,locations:[]});
  await assert.rejects(f.commit(),/多位置 ledger/);
});
test('receipt is server-only and no direct client stock write was enabled',()=>{
  const fs=require('node:fs');
  const rules=fs.readFileSync('firestore.rules','utf8');
  assert.match(rules,/match \/reservationOperationReceipts\/\{id\} \{\s+allow read, write: if false;/);
  const source=fs.readFileSync('functions/index.js','utf8');
  assert.match(source,/if\(!allowGroupedReservation\(\)\)/);
  const gate=fs.readFileSync('functions/grouped-reservation-gate.js','utf8');
  assert.match(gate,/ENABLE_GROUPED_RESERVATION!=='true'/);
  for(const name of ['inventory-core.js','reservation-core.js','fulfillment-core.js'])
    assert.equal(fs.readFileSync('modules/'+name,'utf8'),fs.readFileSync('functions/shared/'+name,'utf8'));
});

test('initial grouped sync refuses fulfilled items; standard return workflows retain authority',async()=>{
  const f=fixture();
  f.docs.get('orders/O').items[0].deliveredQty=6;
  f.docs.get('orders/O').items[0].returnedQty=2;
  const before=f.snapshot();
  await assert.rejects(f.commit(f.request(1,3)),/已履約/);
  assert.equal(f.snapshot(),before);
});
test('CLOSE return does not produce replenishment demand and service product master is authoritative',async()=>{
  const f=fixture(),order=f.docs.get('orders/O');
  order.items[0].deliveredQty=5;order.items[0].returnedQty=2;
  order.returnRecords=[{itemId:'I1',qty:2,settlement:'CLOSE'}];
  const before=f.snapshot();
  await assert.rejects(f.commit(f.request(1,3)),/預留超過待交付數量|已履約/);
  assert.equal(before,f.snapshot());
  const s=fixture();s.docs.get('products/P').productType='Service';
  await assert.rejects(s.commit(),/服務型/);
});
test('orders with inconsistent cancellation fields cannot reopen reservations',async()=>{
  const f=fixture();f.docs.get('orders/O').orderStatus='cancelled';
  await assert.rejects(f.commit(),/已取消/);
});

test('post-sync grouped amendments rebalance and release both warehouses atomically',async()=>{
  const f=fixture();
  await f.commit();
  f.docs.get('orders/O').inventoryReservationStatus='completed';
  const amend=(a,b,attemptId)=>({...f.request(a,b,attemptId),mode:'amend'});
  const exchange=amend(1,4,'amend_exchange_123456789');
  const first=await f.commit(exchange);
  assert.equal(first.status,'applied');
  assert.equal(first.companyReservedDelta,0);
  assert.deepEqual(['inventory/P','warehouseStocks/A__P','warehouseStocks/B__P'].map(k=>f.docs.get(k).reserved),[5,1,4]);
  assert.deepEqual(f.docs.get('orders/O').items.map(row=>row.reservedQty),[1,4]);
  assert.equal(f.docs.get('reservationOperationReceipts/grouped-'+exchange.attemptId).action,'grouped_reservation_amend');
  const snapshot=f.snapshot();
  assert.equal((await f.commit(exchange)).status,'already-applied');
  assert.equal(f.snapshot(),snapshot);
  await assert.rejects(f.commit(amend(2,3,exchange.attemptId)),/操作識別碼/);
  assert.equal(f.snapshot(),snapshot);
  const release=amend(0,0,'amend_release_123456789');
  assert.equal((await f.commit(release)).companyReservedDelta,-5);
  assert.deepEqual(['inventory/P','warehouseStocks/A__P','warehouseStocks/B__P'].map(k=>f.docs.get(k).reserved),[0,0,0]);
  const released=f.snapshot();
  assert.equal((await f.commit(exchange)).status,'already-applied');
  assert.equal(f.snapshot(),released,'old successful intent must not restore released stock');
});

test('post-sync amendment requires completed source, matching attempt and an operational role',async()=>{
  for(const edit of [
    o=>o.inventoryReservationStatus='pending',
    o=>o.inventoryReservationStatus='failed',
    o=>o.inventoryReservationAttemptId='newer_sync_attempt',
    o=>o.status='cancelled'
  ]){
    const f=fixture(),order=f.docs.get('orders/O');
    order.inventoryReservationStatus='completed';edit(order);
    const before=f.snapshot();
    await assert.rejects(f.commit({...f.request(1,2),mode:'amend'}),/同步狀態|已取消/);
    assert.equal(f.snapshot(),before);
  }
  for(const role of ['sales','engineer']){
    const f=fixture({role,owner:'actor'});
    f.docs.get('orders/O').inventoryReservationStatus='completed';
    const before=f.snapshot();
    await assert.rejects(f.commit({...f.request(1,2),mode:'amend'}),/只有採購、倉管或管理員/);
    assert.equal(f.snapshot(),before);
  }
});

test('post-sync amendments reject fulfilled or supplied items without partial writes',async()=>{
  for(const edit of [
    item=>{item.supplyOrderedQty=1;},
    item=>{item.receivedQty=1;},
    item=>{item.deliveredQty=1;},
    item=>{item.dispatchPreparedQty=1;},
    item=>{item.warehouseShippedQty=1;},
    item=>{item.transferPendingId='TRANSIT';}
  ]){
    const f=fixture(),order=f.docs.get('orders/O');
    order.inventoryReservationStatus='completed';edit(order.items[0]);
    const before=f.snapshot();
    await assert.rejects(f.commit({...f.request(1,2),mode:'amend'}),/已履約|供應進度|途中/);
    assert.equal(f.snapshot(),before);
  }
});

test('post-sync amendment updates linked purchase demands in the SAME atomic transaction',async()=>{
  const f=fixture();await f.commit();
  f.docs.get('orders/O').inventoryReservationStatus='completed';
  const demandId=itemId=>'procurementDemands/'+encodeURIComponent('SALES_ORDER:O:'+itemId);
  const demand=(itemId,index,warehouseId,requestedQty)=>({
    demandId:'SALES_ORDER:O:'+itemId,sourceType:'SALES_ORDER',sourceId:'O',
    sourceItemId:itemId,sourceItemIndex:index,productKey:'P',warehouseId,
    ownerUid:'sales1',salesCode:'S01',requestedQty,orderedQty:0,
    receivedQty:0,status:'PENDING',scheduleDate:'2026-10-28',createdAt:'2026-10-01'
  });
  f.set(demandId('I1'),demand('I1',0,'A',3));
  f.set(demandId('I2'),demand('I2',1,'B',2));
  const request={...f.request(1,4,'amend_demand_123456789'),mode:'amend'};
  assert.equal((await f.commit(request)).companyReservedDelta,0);
  const first=f.docs.get(demandId('I1')),second=f.docs.get(demandId('I2'));
  assert.deepEqual([first.requestedQty,first.remainingToOrderQty,
    second.requestedQty,second.remainingToOrderQty],[4,4,1,1]);
  assert.equal(first.scheduleDate,'2026-10-28');
  assert.equal(second.createdAt,'2026-10-01');
  const snapshot=f.snapshot();
  assert.equal((await f.commit(request)).status,'already-applied');
  assert.equal(f.snapshot(),snapshot);
  const release={...f.request(0,0,'amend_demand_release_123456789'),mode:'amend'};
  await f.commit(release);
  assert.deepEqual([f.docs.get(demandId('I1')).requestedQty,
    f.docs.get(demandId('I2')).requestedQty],[5,5]);
  assert.deepEqual(['inventory/P','warehouseStocks/A__P','warehouseStocks/B__P']
    .map(k=>f.docs.get(k).reserved),[0,0,0]);
});

test('post-sync amendment fails closed on recorded supplier progress or demand identity drift',async()=>{
  const demandId='procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I1');
  for(const edit of [
    d=>{d.orderedQty=1;},
    d=>{d.receivedQty=1;},
    d=>{d.status='CANCELLED';},
    d=>{d.sourceId='OTHER';},
    d=>{d.productKey='OTHER';},
    d=>{d.warehouseId='OTHER';}
  ]){
    const f=fixture();await f.commit();
    f.docs.get('orders/O').inventoryReservationStatus='completed';
    const record={demandId:'SALES_ORDER:O:I1',sourceType:'SALES_ORDER',sourceId:'O',
      sourceItemId:'I1',productKey:'P',warehouseId:'A',ownerUid:'sales1',
      salesCode:'S01',orderedQty:0,receivedQty:0,status:'PENDING'};
    edit(record);f.set(demandId,record);
    const before=f.snapshot();
    await assert.rejects(f.commit({...f.request(1,4,'amend_demand_guard_123456789'),mode:'amend'}),
      /已有採購承諾|採購需求與來源訂單不一致/);
    assert.equal(f.snapshot(),before);
  }
});

test('post-sync amendment creates missing shortage demand without inventing supplier history',async()=>{
  const f=fixture();await f.commit();
  f.docs.get('orders/O').inventoryReservationStatus='completed';
  await f.commit({...f.request(1,4,'amend_create_demand_123456789'),mode:'amend'});
  const demandId='procurementDemands/'+encodeURIComponent('SALES_ORDER:O:I1');
  const demand=f.docs.get(demandId);
  assert.equal(demand.requestedQty,4);
  assert.equal(demand.orderedQty,0);
  assert.equal(demand.receivedQty,0);
  assert.equal(demand.status,'PENDING');
});

test('original initial-sync receipt fingerprint is unchanged and modes cannot reuse one ID',async()=>{
  const f=fixture(),intent=f.request();
  assert.equal(normalizeIntent(intent).hash,normalizeIntent({...intent,mode:'initial'}).hash);
  assert.notEqual(normalizeIntent(intent).hash,normalizeIntent({...intent,mode:'amend'}).hash);
  for(const mode of ['',null,'restore','cancelled'])
    assert.throws(()=>normalizeIntent({...intent,mode}),/模式不正確/);
  await f.commit();
  f.docs.get('orders/O').inventoryReservationStatus='completed';
  const before=f.snapshot();
  await assert.rejects(f.commit({...intent,mode:'amend'}),/操作識別碼/);
  assert.equal(f.snapshot(),before);
});

test('stale or completed order sync attempt cannot mutate stock, including newer attempt replay',async()=>{
 const f=fixture();
 for(const change of [
   o=>o.inventoryReservationAttemptId='newer_attempt_12345',
   o=>o.inventoryReservationStatus='completed',
   o=>o.inventoryReservationStatus='failed'
 ]){
   const old=f.snapshot(),order=f.docs.get('orders/O');change(order);
   const before=f.snapshot();
   await assert.rejects(f.commit(f.request()),/同步狀態已變更/);
   assert.equal(f.snapshot(),before);
   f.docs.clear();for(const [k,v] of JSON.parse(old))f.docs.set(k,v);
 }
 await f.commit();
 f.docs.get('orders/O').inventoryReservationStatus='completed';
 assert.equal((await f.commit()).status,'already-applied');
});
