'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const demandCore=require('../functions/shared/procurement-demand-core');
const {commitV2SelfOrder,selfOrderIntent}=require('../functions/quick-purchase-commit-service');
const {selfOrderBackendProject,createSelfOrderCallable}=require('../functions/self-order-callable');
const {verifyQuickPurchaseReceipt}=require('../functions/supply-receipt-service');

function fixture({directShip=false,mixed=false}={}){
 const orderId='ORDER-1',itemId='I1',productId='P',warehouseId=directShip?'':'W';
 const item={itemId,productId,warehouseId,procurementType:'SALES_SELF_ORDER',
  fulfillmentType:directShip?'DIRECT_SHIP':'WAREHOUSE',productType:'GOODS',
  qty:directShip?7:12,reservedQty:directShip?0:5,shortageQty:directShip?0:7,
  supplyOrderedQty:0,receivedQty:0};
 const order={ownerUid:'seller',salesCode:'B',status:'active',orderStatus:'normal',
  inventoryReservationAttemptId:'attempt-self-order-001',
  inventoryReservationStatus:'completed',workCategories:['ordering'],
  items:[item,...(mixed?[{itemId:'SERV',productId:'S',productType:'SERVICE',
   fulfillmentType:'WAREHOUSE',warehouseId:'',inventoryProductKey:'',reservationStatus:'not_required',
   qty:1,reservedQty:0,shortageQty:0,supplyOrderedQty:0,receivedQty:0}]:[])]};
 const demandId=demandCore.demandIdForSource({sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId});
 const demand=demandCore.demandDocument(demandCore.fromSalesOrder({...item,
  requiredSupplyQty:directShip?7:undefined,sourceType:'SALES_ORDER',sourceId:orderId,
  sourceItemId:itemId,sourceItemIndex:0,ownerUid:'seller',salesCode:'B',productKey:productId}));
 const records=new Map([
  ['users/seller',{role:'sales',active:true,name:'Seller'}],
  ['users/engineer',{role:'engineer',active:true,name:'Engineer'}],
  ['users/buyer',{role:'purchaser',active:true}],
  ['users/admin',{role:'admin',active:true}],
  ['users/off',{role:'sales',active:false}],
  ['orders/'+orderId,order],
  ['products/'+productId,{productType:'GOODS',active:true}],
  ['procurementDemands/'+encodeURIComponent(demandId),demand]
 ]);
 if(mixed)records.set('products/S',{productType:'SERVICE',active:true});
 if(!directShip){
  records.set('inventoryReservations/'+orderId+'__'+itemId,{orderId,itemId,productKey:productId,
   warehouseId,ownerUid:'seller',salesCode:'B',quantity:5,shortageQty:7,status:'active'});
  records.set('warehouses/W',{active:true});
  records.set('inventory/P',{productId:'P',productKey:'P',onHand:5,reserved:2,incoming:0});
  records.set('warehouseStocks/W__P',{productId:'P',productKey:'P',warehouseId:'W',onHand:5,reserved:2,incoming:0});
 }
 const writes=[];
 const db={projectId:'demo-yushin',databaseId:'(default)',
  collection(name){return {doc(id){return {path:name+'/'+id,id};}};},
  async runTransaction(callback){
   const staged=[];
   const tx={async get(ref){assert.equal(staged.length,0,'reads precede writes');
    return {exists:records.has(ref.path),data:()=>structuredClone(records.get(ref.path))};},
    create(ref,data){staged.push({action:'create',ref,data});},
    set(ref,data){staged.push({action:'set',ref,data});},
    update(ref,data){staged.push({action:'update',ref,data});}};
   const result=await callback(tx);
   for(const p of staged){
    if(p.action==='create'&&records.has(p.ref.path))throw Error('duplicate');
    if(p.action==='update'&&!records.has(p.ref.path))throw Error('missing');
   }
   for(const p of staged){
    records.set(p.ref.path,p.action==='update'?{...records.get(p.ref.path),...p.data}:structuredClone(p.data));
    writes.push(p.ref.path);
   }
   return result;
  }
 };
 const data={operationId:'so-20261110-001',orderId,itemId,qty:4,supplier:'Vendor',unitCost:0,
  orderDate:'2026-11-10',notes:'客戶急件'};
 const get=async ref=>({exists:records.has(ref.path),data:()=>structuredClone(records.get(ref.path))});
 return {db,records,writes,data,demandId,get};
}

test('owner self-order atomically records supplier, demand, source and company/warehouse incoming',async()=>{
 const f=fixture(),res=await commitV2SelfOrder(f.db,'seller',f.data);
 assert.equal(res.status,'committed');assert.equal(res.supplyId,'self-ORDER-1-I1');
 const supply=f.records.get('supplyOrders/'+res.supplyId),line=f.records.get('orders/ORDER-1').items[0];
 assert.equal(supply.type,'SALES_SELF_ORDER');assert.equal(supply.notes,'客戶急件');
 assert.equal(supply.createdByUid,'seller');assert.equal(supply.incomingRegisteredQty,4);
 assert.equal(f.records.get('inventory/P').incoming,4);
 assert.equal(f.records.get('warehouseStocks/W__P').incoming,4);
 assert.equal(f.records.get('inventoryMovements/self-'+f.data.operationId).qty,4);
 assert.equal(line.supplyOrderedQty,4);assert.deepEqual(line.selfOrderNos,[supply.internalNo]);
 assert.equal(line.costPrice,undefined,'do not expose new supplier cost on shared order projection');
 assert.equal(f.records.get('procurementDemands/'+encodeURIComponent(f.demandId)).orderedQty,4);
 const warehouseView=f.records.get('receivingSupplyOrders/'+res.supplyId);
 assert.equal(warehouseView.unitCost,undefined);
 assert.equal(Object.hasOwn(warehouseView.orderEvents[0],'unitCost'),false);
 await verifyQuickPurchaseReceipt(f.get,f.db,supply,f.records.get('orders/ORDER-1'),res.supplyId);
 const count=f.writes.length;
 const replay=await commitV2SelfOrder(f.db,'seller',f.data);
 assert.equal(replay.status,'already-applied');assert.equal(f.writes.length,count);
 for(const bad of [{...f.data,qty:2},{...f.data,notes:'other'}])
  await assert.rejects(commitV2SelfOrder(f.db,'seller',bad),{code:'already-exists'});
 assert.equal(f.writes.length,count);
});

test('nonowners and purchasing roles cannot create or replay salesperson commitments',async()=>{
 for(const who of ['buyer','admin','engineer','off','unknown']){
  const f=fixture();
  await assert.rejects(commitV2SelfOrder(f.db,who,f.data),{
   code:['engineer'].includes(who)?'permission-denied':'permission-denied'});
  assert.equal(f.writes.length,0);
 }
 const f=fixture();await commitV2SelfOrder(f.db,'seller',f.data);
 f.records.get('orders/ORDER-1').ownerUid='other';
 await assert.rejects(commitV2SelfOrder(f.db,'seller',f.data),{code:'failed-precondition'});
});

test('stale demand, invalid stock, overorder and mismatched source are rejected before writes',async()=>{
 const changes=[
  f=>{f.data.qty=8;},
  f=>{f.records.get('orders/ORDER-1').items[0].procurementType='PURCHASING_PO';},
  f=>{f.records.get('orders/ORDER-1').items[0].productType='SERVICE';},
  f=>{f.records.get('orders/ORDER-1').status='cancelled';},
  f=>{f.records.get('orders/ORDER-1').inventoryReservationStatus='pending';},
  f=>{f.records.get('procurementDemands/'+encodeURIComponent(f.demandId)).orderedQty=1;},
  f=>{f.records.delete('inventoryReservations/ORDER-1__I1');},
  f=>{f.records.get('orders/ORDER-1').inventoryReservationAttemptId='';},
  f=>{f.records.delete('warehouseStocks/W__P');},
  f=>{f.records.get('inventory/P').incoming=-1;},
  f=>{f.records.get('warehouseStocks/W__P').productKey='wrong';}
 ];
 for(const change of changes){
  const f=fixture();change(f);
  await assert.rejects(commitV2SelfOrder(f.db,'seller',f.data));
  assert.equal(f.writes.length,0);
 }
});

test('receipt rejects forged source operation, demand, owner and incoming movement',async()=>{
 const changes=[
  f=>f.records.delete('purchaseOperations/self-'+f.data.operationId),
  f=>f.records.delete('inventoryMovements/self-'+f.data.operationId),
  f=>{f.records.get('inventoryMovements/self-'+f.data.operationId).sourceId='forged';},
  f=>{f.records.get('purchaseOperations/self-'+f.data.operationId).hash='forged';},
  f=>{f.records.get('orders/ORDER-1').items[0].selfOrderNos=[];},
  f=>{f.records.get('procurementDemands/'+encodeURIComponent(f.demandId)).ownerUid='forged';},
  f=>{f.records.get('orders/ORDER-1').ownerUid='forged';},
  f=>{f.records.get('supplyOrders/self-ORDER-1-I1').incomingRegisteredQty=999;}
 ];
 for(const change of changes){
  const f=fixture();await commitV2SelfOrder(f.db,'seller',f.data);
  const count=f.writes.length;change(f);
  await assert.rejects(verifyQuickPurchaseReceipt(f.get,f.db,
   f.records.get('supplyOrders/self-ORDER-1-I1'),f.records.get('orders/ORDER-1'),
   'self-ORDER-1-I1'),{code:'failed-precondition'});
  assert.equal(f.writes.length,count);
 }
});

test('direct ship and a valid mixed service order preserve a cost-free physical receiving source',async()=>{
 for(const options of [{directShip:true}]){
  const f=fixture(options),res=await commitV2SelfOrder(f.db,'seller',f.data);
  const supply=f.records.get('supplyOrders/'+res.supplyId);
  assert.equal(f.records.get('receivingSupplyOrders/'+res.supplyId).unitCost,undefined);
  if(options.directShip){
   assert.equal(f.writes.some(path=>/^(inventory|warehouseStocks|inventoryMovements)\//.test(path)),false);
   assert.equal(supply.incomingRegisteredQty,0);
  }
  await verifyQuickPurchaseReceipt(f.get,f.db,supply,f.records.get('orders/ORDER-1'),res.supplyId);
 }
 const mixed=fixture({mixed:true}),committed=await commitV2SelfOrder(mixed.db,'seller',mixed.data);
 assert.equal(committed.status,'committed');
 assert.equal(mixed.records.get('orders/ORDER-1').items[1].supplyOrderedQty,0);
 assert.equal(mixed.records.has('inventoryReservations/ORDER-1__SERV'),false);
 assert.equal(mixed.records.has('procurementDemands/SALES_ORDER%3AORDER-1%3ASERV'),false);
 const supply=mixed.records.get('supplyOrders/'+committed.supplyId);
 await verifyQuickPurchaseReceipt(mixed.get,mixed.db,supply,mixed.records.get('orders/ORDER-1'),committed.supplyId);
 assert.equal((await commitV2SelfOrder(mixed.db,'seller',mixed.data)).status,'already-applied');
 for(const corrupt of [
  f=>{f.records.get('orders/ORDER-1').items[1].reservedQty=1;},
  f=>{f.records.get('products/S').active=false;},
  f=>{f.records.set('inventoryReservations/ORDER-1__SERV',{});},
  f=>{f.records.set('procurementDemands/SALES_ORDER%3AORDER-1%3ASERV',{});}
 ]){
  const f=fixture({mixed:true});corrupt(f);
  await assert.rejects(commitV2SelfOrder(f.db,'seller',f.data),{code:'failed-precondition'});
  assert.equal(f.writes.length,0);
 }
});

test('self-order strict request rejects forged role, malformed operation/date, costs and notes',()=>{
 const f=fixture();assert.deepEqual(selfOrderIntent(f.data),f.data);
 for(const bad of [{...f.data,role:'admin'},{...f.data,qty:1.5},{...f.data,unitCost:-1},
  {...f.data,orderDate:'2026-02-30'},{...f.data,operationId:'abc'},
  {...f.data,notes:' '.repeat(1001)}])assert.throws(()=>selfOrderIntent(bad),{code:'invalid-argument'});
});

test('self-order backend is default closed and requires exact independent project flag',async()=>{
 const demo={GCLOUD_PROJECT:'demo-yushin',FUNCTIONS_EMULATOR:'true',ENABLE_SELF_ORDER_EMULATOR:'true',
  FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'};
 const prod={GCLOUD_PROJECT:'yu-shing-company',ENABLE_PRODUCTION_SELF_ORDER_BACKEND:'true',
  ENABLE_PRODUCTION_RECEIVING_BACKEND:'true'};
 assert.equal(selfOrderBackendProject(demo),'demo-yushin');
 assert.equal(selfOrderBackendProject(prod),'yu-shing-company');
 for(const bad of [{...prod,ENABLE_PRODUCTION_SELF_ORDER_BACKEND:'false'},
  {...prod,ENABLE_PRODUCTION_RECEIVING_BACKEND:'false'},
  {...prod,ENABLE_PRODUCTION_RECEIVING_BACKEND:undefined},
  {...prod,FUNCTIONS_EMULATOR:'true'},{...prod,FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'},
  {...demo,GCLOUD_PROJECT:'yu-shing-company'},
  {GCLOUD_PROJECT:'preview-20135',ENABLE_PRODUCTION_SELF_ORDER_BACKEND:'true'}])
  assert.equal(selfOrderBackendProject(bad),'');
 class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
 const f=fixture(),callable=createSelfOrderCallable({
  onCall:(_config,fn)=>fn,HttpsError,getDatabase:()=>f.db,env:demo});
 await assert.rejects(callable({data:f.data}),{code:'unauthenticated'});
 await assert.rejects(callable({auth:{uid:'buyer'},data:f.data}),{code:'permission-denied'});
 assert.equal((await callable({auth:{uid:'seller'},data:f.data})).status,'committed');
 assert.equal((await callable({auth:{uid:'seller'},data:f.data})).status,'already-applied');
});
