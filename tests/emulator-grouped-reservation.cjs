'use strict';
// Real Firebase Admin SDK + Firestore Emulator transactions. No production
// app, credentials, network services, or browser SDK writes are involved.
const test=require('node:test'),assert=require('node:assert/strict');
const admin=require('firebase-admin');
const {getFirestore}=require('firebase-admin/firestore');
const {commitGroupedWarehouseReservation}=require('../functions/grouped-reservation-service');

let db,app;
test.before(()=>{
  assert.ok(process.env.FIRESTORE_EMULATOR_HOST,'Must run inside Firestore Emulator');
  app=admin.initializeApp({projectId:'demo-yushin'},'grouped-reservation-emulator-tests');
  db=getFirestore(app);
});
test.after(async()=>{if(app)await app.delete();});
async function seed(id,{role='purchaser',owner='sales1'}={}){
  const itemId1='I1',itemId2='I2',productKey='prod-'+id;
  const orderId='order-'+id,uid='actor-'+id;
  const batch=db.batch();
  const set=(path,data)=>batch.set(db.doc(path),data);
  set('users/'+uid,{active:true,role,salesCode:'S01'});
  set('orders/'+orderId,{ownerUid:owner==='actor'?uid:owner,salesCode:'S01',status:'active',
    inventoryReservationStatus:'pending',inventoryReservationAttemptId:'sync_'+id+'_123456789',items:[
    {itemId:itemId1,productId:productKey,warehouseId:'A',qty:5,reservedQty:0},
    {itemId:itemId2,productId:productKey,warehouseId:'B',qty:5,reservedQty:0}
  ]});
  set('products/'+productKey,{productId:productKey,productType:'Goods'});
  set('inventory/'+productKey,{productKey,onHand:20,reserved:0,transferFreeInTransit:0});
  for(const wh of ['A','B']){
    set('warehouses/'+wh,{active:true});
    set('warehouseStocks/'+wh+'__'+productKey,{productKey,warehouseId:wh,onHand:10,reserved:0,transferFreeInTransit:0});
  }
  await batch.commit();
  const intent=(a,b,attempt='attempt_'+id+'_123456789')=>({orderId,attemptId:attempt,
    syncAttemptId:'sync_'+id+'_123456789',items:[
    {itemId:itemId1,quantity:a},{itemId:itemId2,quantity:b}
  ]});
  const doc=async path=>(await db.doc(path).get()).data();
  return {uid,orderId,productKey,intent,doc,
    call:(data,otherUid=uid)=>commitGroupedWarehouseReservation(db,otherUid,data)};
}
test('Admin SDK transaction commits company/warehouse/reservation/receipts together and replays safely',async()=>{
  const f=await seed('atomic');
  const result=await f.call(f.intent(2,3));assert.equal(result.status,'applied');
  assert.equal((await f.doc('inventory/'+f.productKey)).reserved,5);
  assert.equal((await f.doc('warehouseStocks/A__'+f.productKey)).reserved,2);
  assert.equal((await f.doc('warehouseStocks/B__'+f.productKey)).reserved,3);
  assert.equal((await f.doc('inventoryReservations/'+f.orderId+'__I1')).quantity,2);
  assert.equal((await f.doc('inventoryReservations/'+f.orderId+'__I2')).quantity,3);
  assert.equal((await f.call(f.intent(2,3))).status,'already-applied');
  assert.equal((await f.doc('inventory/'+f.productKey)).reserved,5);
  await assert.rejects(f.call(f.intent(3,2)),/操作識別碼/);
});
test('Emulator commit rejects stolen owner and disabled actor with no stock change',async()=>{
  const sales=await seed('owner',{role:'sales',owner:'someone-else'});
  await assert.rejects(sales.call(sales.intent(1,1)),/自己的訂單/);
  assert.equal((await sales.doc('inventory/'+sales.productKey)).reserved,0);
  const off=await seed('disabled');
  await db.doc('users/'+off.uid).update({active:false});
  await assert.rejects(off.call(off.intent(2,3)),/停用/);
  assert.equal((await off.doc('inventory/'+off.productKey)).reserved,0);
});
test('Emulator transaction keeps both warehouse totals consistent under simultaneous distinct operations',async()=>{
  const f=await seed('concurrent');
  await Promise.all([
    f.call(f.intent(2,3,'attempt_concurrent_A_12345')),
    f.call(f.intent(3,2,'attempt_concurrent_B_12345'))
  ]);
  const a=(await f.doc('warehouseStocks/A__'+f.productKey)).reserved;
  const b=(await f.doc('warehouseStocks/B__'+f.productKey)).reserved;
  const total=(await f.doc('inventory/'+f.productKey)).reserved;
  const order=await f.doc('orders/'+f.orderId);
  assert.equal(a+b,total);assert.equal(total,5);
  assert.equal(order.items[0].reservedQty,a);assert.equal(order.items[1].reservedQty,b);
  assert.equal((await f.doc('inventoryReservations/'+f.orderId+'__I1')).quantity,a);
  assert.equal((await f.doc('inventoryReservations/'+f.orderId+'__I2')).quantity,b);
});
test('Emulator rejects insufficient physical stock atomically',async()=>{
  const f=await seed('shortage');
  await db.doc('warehouseStocks/A__'+f.productKey).update({onHand:1});
  await assert.rejects(f.call(f.intent(2,3)),/庫存不足/);
  assert.equal((await f.doc('inventory/'+f.productKey)).reserved,0);
  assert.equal((await f.doc('warehouseStocks/B__'+f.productKey)).reserved,0);
  assert.equal((await db.doc('reservationOperationReceipts/grouped-attempt_shortage_123456789').get()).exists,false);
});

test('Admin transaction refuses a stale initial-sync attempt without changing stock',async()=>{
 const f=await seed('stale');
 await db.doc('orders/'+f.orderId).update({inventoryReservationAttemptId:'newer_attempt'});
 await assert.rejects(f.call(f.intent(2,3)),/同步狀態已變更/);
 assert.equal((await f.doc('inventory/'+f.productKey)).reserved,0);
 assert.equal((await db.doc('reservationOperationReceipts/grouped-attempt_stale_123456789').get()).exists,false);
});


async function fiveLineFixture(id){
  const f=await seed(id);
  const items=['A','A','A','B','B'].map((warehouseId,index)=>({
    itemId:'I'+(index+1),productId:f.productKey,warehouseId,qty:5,reservedQty:0
  }));
  await db.doc('orders/'+f.orderId).update({items});
  await db.doc('inventory/'+f.productKey).update({onHand:40});
  for(const warehouseId of ['A','B'])
    await db.doc('warehouseStocks/'+warehouseId+'__'+f.productKey).update({onHand:20});
  const intent=(values,attemptId='attempt_'+id+'_123456789')=>{
    assert.equal(values.length,5);
    return {orderId:f.orderId,attemptId,syncAttemptId:'sync_'+id+'_123456789',
      items:items.map((item,index)=>({itemId:item.itemId,quantity:values[index]}))};
  };
  const balances=async()=>{
    const company=await f.doc('inventory/'+f.productKey);
    const a=await f.doc('warehouseStocks/A__'+f.productKey);
    const b=await f.doc('warehouseStocks/B__'+f.productKey);
    const order=await f.doc('orders/'+f.orderId);
    const reservations=await Promise.all(items.map(item=>
      f.doc('inventoryReservations/'+f.orderId+'__'+item.itemId)));
    return {company:company.reserved,a:a.reserved,b:b.reserved,
      order:order.items.map(item=>item.reservedQty),
      reservations:reservations.map(item=>item?.quantity??0)};
  };
  return {...f,intent,balances};
}

test('five order lines over two warehouses commit, rebalance and release atomically via Admin SDK',async()=>{
  const f=await fiveLineFixture('five-lines');
  const first=f.intent([2,3,1,4,2],'attempt_five_lines_123456789');
  assert.equal((await f.call(first)).status,'applied');
  assert.deepEqual(await f.balances(),{company:12,a:6,b:6,
    order:[2,3,1,4,2],reservations:[2,3,1,4,2]});

  const exchange=f.intent([1,4,2,3,2],'attempt_five_lines_exchange_123456789');
  const exchanged=await f.call(exchange);
  assert.equal(exchanged.companyReservedDelta,0);
  assert.deepEqual(await f.balances(),{company:12,a:7,b:5,
    order:[1,4,2,3,2],reservations:[1,4,2,3,2]});

  const release=f.intent([0,0,0,0,0],'attempt_five_lines_release_123456789');
  assert.equal((await f.call(release)).companyReservedDelta,-12);
  const zero={company:0,a:0,b:0,order:[0,0,0,0,0],reservations:[0,0,0,0,0]};
  assert.deepEqual(await f.balances(),zero);
  assert.equal((await f.call(first)).status,'already-applied');
  assert.equal((await f.call(exchange)).status,'already-applied');
  assert.deepEqual(await f.balances(),zero,'an old receipt replay must not restore a released hold');
  assert.equal((await f.doc('reservationOperationReceipts/grouped-'+release.attemptId)).companyReservedDelta,-12);
});

test('five-line multiwarehouse insufficiency rejects the whole transaction and creates no receipt',async()=>{
  const f=await fiveLineFixture('five-fail');
  await db.doc('warehouseStocks/A__'+f.productKey).update({onHand:5});
  const before=await f.balances();
  const request=f.intent([2,3,1,4,2],'attempt_five_fail_123456789');
  await assert.rejects(f.call(request),/庫存不足/);
  assert.deepEqual(await f.balances(),before);
  assert.equal((await db.doc('reservationOperationReceipts/grouped-'+request.attemptId).get()).exists,false);
  assert.equal((await db.doc('inventoryMovements/grouped-'+request.attemptId+'-B').get()).exists,false);
});

test('five same-product lines in ONE warehouse use the Admin writer without Rules proofs',async()=>{
  const f=await fiveLineFixture('five-same');
  await db.doc('orders/'+f.orderId).update({items:(await f.doc('orders/'+f.orderId)).items.map(item=>({...item,warehouseId:'A'}))});
  const commit=data=>commitGroupedWarehouseReservation(db,f.uid,data,{allowSameWarehouse:true});
  const initial=f.intent([2,3,1,4,2],'attempt_five_same_123456789');
  await assert.rejects(f.call(initial),/尚未獨立啟用/);
  assert.equal((await f.doc('inventory/'+f.productKey)).reserved,0);
  assert.equal((await commit(initial)).companyReservedDelta,12);
  assert.deepEqual(await f.balances(),{company:12,a:12,b:0,
    order:[2,3,1,4,2],reservations:[2,3,1,4,2]});
  assert.equal((await commit(initial)).status,'already-applied');
  await db.doc('orders/'+f.orderId).update({inventoryReservationStatus:'completed'});
  const amend=(values,attemptId)=>({...f.intent(values,attemptId),mode:'amend'});
  assert.equal((await commit(amend([1,4,2,3,2],'amend_five_same_exchange_1234'))).companyReservedDelta,0);
  assert.deepEqual(await f.balances(),{company:12,a:12,b:0,
    order:[1,4,2,3,2],reservations:[1,4,2,3,2]});
  const release=amend([0,0,0,0,0],'amend_five_same_release_1234');
  assert.equal((await commit(release)).companyReservedDelta,-12);
  const zero={company:0,a:0,b:0,order:[0,0,0,0,0],reservations:[0,0,0,0,0]};
  assert.deepEqual(await f.balances(),zero);
  assert.equal((await commit(release)).status,'already-applied');
  assert.deepEqual(await f.balances(),zero);
});

test('five-line completed order can rebalance then release through gated server writer',async()=>{
  const f=await fiveLineFixture('five-amend');
  await f.call(f.intent([2,3,1,4,2]));
  await db.doc('orders/'+f.orderId).update({inventoryReservationStatus:'completed'});
  const amend=(values,attemptId)=>({...f.intent(values,attemptId),mode:'amend'});
  const exchange=amend([1,4,2,3,2],'amend_five_exchange_123456789');
  assert.equal((await f.call(exchange)).companyReservedDelta,0);
  assert.deepEqual(await f.balances(),{company:12,a:7,b:5,
    order:[1,4,2,3,2],reservations:[1,4,2,3,2]});
  const receipt=await f.doc('reservationOperationReceipts/grouped-'+exchange.attemptId);
  assert.equal(receipt.action,'grouped_reservation_amend');
  assert.equal((await f.call(exchange)).status,'already-applied');
  const release=amend([0,0,0,0,0],'amend_five_release_123456789');
  assert.equal((await f.call(release)).companyReservedDelta,-12);
  const zero={company:0,a:0,b:0,order:[0,0,0,0,0],reservations:[0,0,0,0,0]};
  assert.deepEqual(await f.balances(),zero);
  assert.equal((await f.call(exchange)).status,'already-applied');
  assert.deepEqual(await f.balances(),zero,'lost-response replay cannot roll back a later release');
});

test('post-sync server writer rejects stale status and supplier progress without partial stock updates',async()=>{
  const f=await fiveLineFixture('amend-guard');
  const intent={...f.intent([1,1,1,1,1],'amend_guard_123456789'),mode:'amend'};
  const before=await f.balances();
  await assert.rejects(f.call(intent),/同步狀態/);
  assert.deepEqual(await f.balances(),before);
  await db.doc('orders/'+f.orderId).update({inventoryReservationStatus:'completed'});
  await db.doc('orders/'+f.orderId).update({items:(await f.doc('orders/'+f.orderId)).items.map((item,i)=>
    i===4?{...item,supplyOrderedQty:1}:item)});
  await assert.rejects(f.call(intent),/供應進度/);
  assert.deepEqual(await f.balances(),before);
  assert.equal((await db.doc('reservationOperationReceipts/grouped-'+intent.attemptId).get()).exists,false);
});

test('Emulator amendment keeps linked demand and stock consistent, and blocks supplier progress',async()=>{
  const f=await fiveLineFixture('amend-demand');
  const initial=f.intent([2,3,1,4,2]);
  await f.call(initial);
  await db.doc('orders/'+f.orderId).update({inventoryReservationStatus:'completed'});
  const demandId='SALES_ORDER:'+f.orderId+':I1';
  const demandRef=db.doc('procurementDemands/'+encodeURIComponent(demandId));
  await demandRef.set({demandId,sourceType:'SALES_ORDER',sourceId:f.orderId,
    sourceItemId:'I1',sourceItemIndex:0,productKey:f.productKey,warehouseId:'A',
    ownerUid:'sales1',salesCode:'S01',orderedQty:0,receivedQty:0,
    requestedQty:3,status:'PENDING',scheduleDate:'2026-10-28',createdAt:'2026-10-01'});
  const amend=(values,attemptId)=>({...f.intent(values,attemptId),mode:'amend'});
  const exchange=amend([1,4,2,3,2],'amend_with_demand_123456789');
  assert.equal((await f.call(exchange)).companyReservedDelta,0);
  assert.equal((await demandRef.get()).data().requestedQty,4);
  assert.deepEqual(await f.balances(),{company:12,a:7,b:5,
    order:[1,4,2,3,2],reservations:[1,4,2,3,2]});
  await demandRef.update({orderedQty:1,status:'PARTIALLY_ORDERED'});
  const before=await f.balances();
  const denied=amend([0,4,2,3,2],'amend_demand_denied_123456789');
  await assert.rejects(f.call(denied),/已有採購承諾/);
  assert.deepEqual(await f.balances(),before);
  assert.equal((await db.doc('reservationOperationReceipts/grouped-'+denied.attemptId).get()).exists,false);
});
