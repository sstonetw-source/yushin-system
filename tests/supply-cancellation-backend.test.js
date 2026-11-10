'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const demandCore=require('../functions/shared/procurement-demand-core');
const {cancellationIntent,supplyCancellationProject,commitSupplyCancellation,createSupplyCancellationCallables}
 =require('../functions/supply-cancellation-service');
const demo={GCLOUD_PROJECT:'demo-yushin',FUNCTIONS_EMULATOR:'true',
 FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099',
 ENABLE_SUPPLY_CANCELLATION_EMULATOR:'true'};
const operationId='supplier-stop-20261110-001';
function fixture({direct=false}={}){
 const records=new Map(),writes=[],supplyIds=['S1','S2'];
 const put=(path,data)=>records.set(path,structuredClone(data));
 put('users/buyer',{role:'purchaser',active:true,name:'Buyer'});
 put('users/admin',{role:'admin',active:true,name:'Admin'});
 put('users/seller',{role:'sales',active:true,name:'Seller'});
 put('users/disabled',{role:'purchaser',active:false});
 put('purchaseOrders/PO',{poNo:'PO',status:'ORDERED',documentOnly:false,supplyOrderIds:supplyIds,
  items:[{orderId:'O1',itemId:'i',productId:'P1',qty:5,unitPrice:19},
   {orderId:'O2',itemId:'i',productId:'P2',qty:5,unitPrice:19}]});
 for(let i=0;i<2;i++){
  const id=supplyIds[i],orderId='O'+(i+1),product='P'+(i+1);
  const demandId=demandCore.demandIdForSource({sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:'i'});
  const item={itemId:'i',productId:product,qty:10,orderedQty:10,
   supplyOrderedQty:5,receivedQty:2,reservedQty:0,shortageQty:10};
  put('orders/'+orderId,{ownerUid:'seller',salesCode:'A',status:'active',items:[item]});
  put('procurementDemands/'+encodeURIComponent(demandId),
   demandCore.demandDocument({demandId,sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:'i',
    productId:product,productKey:product,warehouseId:direct?'':'W',ownerUid:'seller',salesCode:'A',
    requestedQty:10,orderedQty:5,receivedQty:2}));
  const supply={type:'PURCHASING_PO',purchaseDocumentId:'PO',orderId,itemId:'i',
   sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:'i',demandId,productId:product,productKey:product,
   warehouseId:direct?'':'W',fulfillmentType:direct?'DIRECT_SHIP':'WAREHOUSE',
   ownerUid:'seller',salesCode:'A',qty:5,receivedQty:2,incomingRegisteredQty:direct?0:3,
   status:'PARTIAL_RECEIPT',unitCost:19};
  put('supplyOrders/'+id,supply);put('receivingSupplyOrders/'+id,{...supply,unitCost:undefined});
  if(!direct){
   put('inventory/'+product,{productKey:product,onHand:10,reserved:3,incoming:3});
   put('warehouseStocks/W__'+product,{productKey:product,warehouseId:'W',onHand:6,reserved:1,incoming:3});
  }
 }
 let queue=Promise.resolve(),failReply=false,failCommit=false;
 const db={projectId:'demo-yushin',databaseId:'(default)',
  collection(name){return {doc(id){return {path:name+'/'+id,id};}};},
  runTransaction(callback){
   // Serialize callbacks like a transaction retry after a conflicting write.
   const task=queue.then(async()=>{
    const pending=[];
    const tx={
     async get(ref){assert.equal(pending.length,0,'all reads must precede writes');
      return {exists:records.has(ref.path),data:()=>structuredClone(records.get(ref.path))};},
     create(ref,data){pending.push({mode:'create',ref,data});},
     set(ref,data){pending.push({mode:'set',ref,data});},
     update(ref,data){pending.push({mode:'update',ref,data});}
    };
    const result=await callback(tx);
    if(failCommit)throw Error('injected commit abort');
    for(const p of pending)if(p.mode==='create'&&records.has(p.ref.path))throw Error('duplicate');
    for(const p of pending)if(p.mode==='update'&&!records.has(p.ref.path))throw Error('missing');
    for(const p of pending){
     const before=records.get(p.ref.path)||{};
     records.set(p.ref.path,structuredClone(p.mode==='update'?{...before,...p.data}:p.data));
     writes.push(p.ref.path);
    }
    if(failReply){failReply=false;throw Error('response lost after commit');}
    return result;
   });
   queue=task.catch(()=>{});
   return task;
  }
 };
 const single={operationId,poId:'PO',supplyId:'S1',reason:'供應商已確認取消'};
 const whole={operationId:'whole-stop-20261110-001',poId:'PO',reason:'供應商停止供貨'};
 return {records,writes,db,single,whole,put,setLost:()=>failReply=true,setAbort:()=>failCommit=true};
}
const run=(x,who='buyer',data=x.single,whole=false)=>commitSupplyCancellation(x.db,who,data,{whole,env:demo});
test('single cancellation atomically releases exact order, demand, company and warehouse incoming',async()=>{
 const x=fixture(),r=await run(x);
 assert.equal(r.status,'applied');assert.equal(r.cancelledQty,3);
 assert.ok(x.records.get('orders/O1').workCategories.includes('ordering'),
  'cancellation should restore the order to its purchasing queue');
 assert.equal(x.records.get('supplyOrders/S1').status,'CLOSED');
 assert.equal(x.records.get('supplyOrders/S1').incomingRegisteredQty,0);
 assert.equal(x.records.get('orders/O1').items[0].supplyOrderedQty,2);
 assert.equal(x.records.get('procurementDemands/SALES_ORDER%3AO1%3Ai').orderedQty,2);
 assert.equal(x.records.get('inventory/P1').incoming,0);
 assert.equal(x.records.get('warehouseStocks/W__P1').incoming,0);
 assert.equal(x.records.get('inventory/P1').onHand,10);
 assert.equal(x.records.get('warehouseStocks/W__P1').reserved,1);
 assert.equal(x.records.get('inventoryMovements/supply-cancel-'+operationId+'-0').qty,-3);
 assert.equal(Object.hasOwn(x.records.get('receivingSupplyOrders/S1'),'unitCost'),false);
 const before=x.writes.length,retry=await run(x);
 assert.equal(retry.status,'already-applied');assert.equal(x.writes.length,before);
 await assert.rejects(run(x,'buyer',{...x.single,operationId:'other-stop-20261110-001'}),{code:'already-exists'});
 await assert.rejects(run(x,'admin'),{code:'already-exists'});
 assert.equal(x.writes.length,before);
});
test('whole PO cancellation is one atomic transaction and closes the PO only after all lines',async()=>{
 const x=fixture(),r=await run(x,'buyer',x.whole,true);
 assert.equal(r.cancelledQty,6);assert.deepEqual(r.supplyIds,['S1','S2']);
 assert.equal(x.records.get('purchaseOrders/PO').status,'CLOSED');
 assert.equal(x.records.get('purchaseOrders/PO').stoppedQty,6);
 assert.equal(x.records.get('inventory/P1').incoming,0);
 assert.equal(x.records.get('inventory/P2').incoming,0);
 assert.equal(x.records.get('inventoryMovements/supply-cancel-'+x.whole.operationId+'-1').qty,-3);
 const count=x.writes.length;
 assert.equal((await run(x,'buyer',x.whole,true)).status,'already-applied');
 assert.equal(x.writes.length,count);
});
test('missing second-line evidence, changing parent links or failed commit leave every line untouched',async()=>{
 for(const change of [
  x=>x.records.delete('warehouseStocks/W__P2'),
  x=>x.records.get('purchaseOrders/PO').supplyOrderIds=['S1','S1'],
  x=>x.records.get('supplyOrders/S2').purchaseDocumentId='wrong',
  x=>x.records.get('orders/O2').items[0].supplyOrderedQty=2,
  x=>x.records.get('procurementDemands/SALES_ORDER%3AO2%3Ai').orderedQty=3,
  x=>x.records.get('inventory/P2').incoming=1,
  x=>x.records.get('warehouseStocks/W__P2').warehouseId='wrong',
  x=>x.setAbort()
 ]){
  const x=fixture();change(x);
  await assert.rejects(run(x,'buyer',x.whole,true));
  assert.equal(x.writes.length,0);
  assert.equal(x.records.get('supplyOrders/S1').status,'PARTIAL_RECEIPT');
  assert.equal(x.records.get('purchaseOrders/PO').status,'ORDERED');
 }
});
test('direct-ship cancellation updates commitments without touching company or warehouse stocks',async()=>{
 const x=fixture({direct:true});
 x.records.get('supplyOrders/S1').receivedQty=0;
 x.records.get('supplyOrders/S1').status='ORDERED';
 x.records.get('orders/O1').items[0].receivedQty=0;
 x.records.get('procurementDemands/SALES_ORDER%3AO1%3Ai').receivedQty=0;
 const r=await run(x);
 assert.equal(r.cancelledQty,5);
 assert.equal(x.records.get('supplyOrders/S1').status,'CANCELLED');
 assert.equal(x.records.get('orders/O1').items[0].supplyOrderedQty,0);
 assert.equal(x.writes.some(path=>path.startsWith('inventory/')),false);
 assert.equal(x.writes.some(path=>path.startsWith('warehouseStocks/')),false);
 assert.equal(x.writes.some(path=>path.startsWith('inventoryMovements/')),false);
});
test('permission, authentication, illegal request and default production gate all reject without writes',async()=>{
 for(const who of ['seller','disabled','unknown']){
  const x=fixture();await assert.rejects(run(x,who),{code:'permission-denied'});
  assert.equal(x.writes.length,0);
 }
 for(const input of [{...fixture().single,reason:' '},{...fixture().single,operationId:'short'},
  {...fixture().single,role:'admin'},{...fixture().single,poId:'wrong/po'}])
  assert.throws(()=>cancellationIntent(input,false),{code:'invalid-argument'});
 assert.equal(supplyCancellationProject({...demo,GCLOUD_PROJECT:'yu-shing-company'}),'');
 assert.equal(supplyCancellationProject({...demo,FUNCTIONS_EMULATOR:'false'}),'');
 assert.equal(supplyCancellationProject({GCLOUD_PROJECT:'yu-shing-company'}),'');
 const x=fixture();
 await assert.rejects(commitSupplyCancellation(x.db,'buyer',x.single,{env:{}}),{code:'failed-precondition'});
 assert.equal(x.writes.length,0);
});
test('lost reply and same-operation concurrent retry never double-decrement',async()=>{
 const x=fixture();x.setLost();
 await assert.rejects(run(x),/response lost/);
 assert.equal(x.records.get('inventory/P1').incoming,0);
 const count=x.writes.length;
 assert.equal((await run(x)).status,'already-applied');
 assert.equal(x.writes.length,count);
 const y=fixture(),two=await Promise.all([run(y),run(y)]);
 assert.deepEqual(two.map(x=>x.status).sort(),['already-applied','applied']);
 assert.equal(y.records.get('inventory/P1').incoming,0);
});
test('prior receipt with a changed reason or corrupted supply witness is not silently accepted',async()=>{
 const x=fixture();await run(x);const count=x.writes.length;
 await assert.rejects(run(x,'buyer',{...x.single,reason:'different reason'}),{code:'already-exists'});
 x.records.delete('inventoryMovements/supply-cancel-'+operationId+'-0');
 await assert.rejects(run(x),{code:'failed-precondition'});
 x.records.set('inventoryMovements/supply-cancel-'+operationId+'-0',
  {sourceId:'S1',operationId,actorUid:'buyer',purchaseDocumentId:'PO',reason:x.single.reason,qty:-3});
 x.records.get('supplyOrders/S1').incomingRegisteredQty=2;
 await assert.rejects(run(x),{code:'failed-precondition'});
 assert.equal(x.writes.length,count);
});
test('manual supply cancellation preserves source PO and recomputes purchasing queue',async()=>{
 const x=fixture(),supply=x.records.get('supplyOrders/S1');
 supply.type='PURCHASING_MANUAL';delete supply.purchaseDocumentId;supply.internalNo='MANUAL-01';
 const request={...x.single,poId:'MANUAL-01',operationId:'manual-stop-20261110-01'};
 const r=await run(x,'buyer',request);
 assert.equal(r.cancelledQty,3);
 assert.equal(x.records.get('supplyOrders/S1').status,'CLOSED');
 assert.equal(x.records.get('purchaseOrders/PO').status,'ORDERED');
 assert.equal(x.records.get('inventory/P1').incoming,0);
 assert.ok(x.records.get('orders/O1').workCategories.includes('ordering'));
});
test('not-yet-registered PO incoming can be cancelled without fabricated stock movements',async()=>{
 const x=fixture(),s=x.records.get('supplyOrders/S1');
 s.incomingRegisteredQty=0;
 x.records.get('inventory/P1').incoming=0;
 x.records.get('warehouseStocks/W__P1').incoming=0;
 const result=await run(x);
 assert.equal(result.cancelledQty,3);
 assert.equal(x.writes.some(path=>path.startsWith('inventoryMovements/')),false);
 assert.equal((await run(x)).status,'already-applied');
});
test('callables validate authenticated users and never fall back to browser writers',async()=>{
 class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
 const make=env=>createSupplyCancellationCallables({onCall:(_config,fn)=>fn,
  HttpsError,getDatabase:()=>fixture().db,env});
 await assert.rejects(make({}).cancelV2OutstandingSupply({auth:{uid:'buyer'},data:fixture().single}),
  {code:'failed-precondition'});
 await assert.rejects(make(demo).cancelV2OutstandingSupply({data:fixture().single}),{code:'unauthenticated'});
 const x=make(demo);
 assert.equal((await x.cancelV2OutstandingSupply({auth:{uid:'buyer'},data:fixture().single})).status,'applied');
 assert.equal((await x.stopV2PurchaseOrderOutstanding({auth:{uid:'buyer'},data:fixture().whole})).status,'applied');
});
