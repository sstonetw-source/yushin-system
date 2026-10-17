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
  f.set('orders/O',{ownerUid:owner,salesCode:'S01',status:'active',items:[
    {itemId:'I1',productId:'P',warehouseId:'A',qty:5,reservedQty:0},
    {itemId:'I2',productId:'P',warehouseId:'B',qty:5,reservedQty:0}
  ]});
  f.set('inventory/P',{productKey:'P',onHand:20,reserved:0,transferFreeInTransit:0});
  for(const wh of ['A','B']){
    f.set('warehouses/'+wh,{active:true,systemCustody:false});
    f.set('warehouseStocks/'+wh+'__P',{productKey:'P',warehouseId:wh,onHand:10,reserved:0,transferFreeInTransit:0});
  }
  const request=(a=2,b=3,attemptId='attempt_123456789')=>({orderId:'O',attemptId,items:[
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
    o=>{o.items[0].dispatchPreparedQty=1;}
  ]){
    const f=fixture();edit(f.docs.get('orders/O'));const before=f.snapshot();
    await assert.rejects(f.commit(),/已取消|待交付|服務|直送|途中|來源|出貨/);
    assert.equal(f.snapshot(),before);
  }
});
test('existing reservation mismatches, disabled warehouses and third warehouse fail closed',async()=>{
  const f=fixture();f.set('inventoryReservations/O__I1',{orderId:'WRONG',productKey:'P',warehouseId:'A',quantity:1});
  let before=f.snapshot();await assert.rejects(f.commit(),/來源與訂單不一致/);assert.equal(f.snapshot(),before);
  const disabled=fixture();disabled.docs.get('warehouses/A').active=false;
  before=disabled.snapshot();await assert.rejects(disabled.commit(),/停用/);assert.equal(disabled.snapshot(),before);
  const third=fixture();third.docs.get('orders/O').items[1].warehouseId='A';
  before=third.snapshot();await assert.rejects(third.commit(),/剛好兩個/);assert.equal(third.snapshot(),before);
});
test('operation limit, intent quantities and unknown location ledger are rejected',async()=>{
  for(const input of [
    {orderId:'O',attemptId:'short',items:[{itemId:'I1',quantity:1},{itemId:'I2',quantity:2}]},
    {orderId:'O',attemptId:'attempt_123456789',items:[{itemId:'I1',quantity:1.3},{itemId:'I2',quantity:2}]},
    {orderId:'O',attemptId:'attempt_123456789',items:[{itemId:'I1',quantity:1},{itemId:'I1',quantity:2}]}
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
  assert.match(source,/ENABLE_GROUPED_RESERVATION.*!==.*true/);
  for(const name of ['inventory-core.js','reservation-core.js'])
    assert.equal(fs.readFileSync('modules/'+name,'utf8'),fs.readFileSync('functions/shared/'+name,'utf8'));
});
