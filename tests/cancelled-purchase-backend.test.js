'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {planCancelledPurchaseKeepStock}=require('../modules/supply-core');
const {commitCancelledPurchaseKeepStock,cancelledPurchaseProject,createCancelledPurchaseCallable}=require('../functions/cancelled-purchase-service');
const env={GCLOUD_PROJECT:'preview-20135',ENABLE_PREVIEW_CANCELLED_PURCHASE:'true'};
const intent={supplyId:'S',warehouseId:'A',expectedDirect:true,operationId:'keep_stock_123456'};
function fixture(){
 const docs=new Map(),put=(p,v)=>docs.set(p,structuredClone(v));let fail=false;
 put('users/U',{role:'purchaser',active:true});put('supplyOrders/S',{orderId:'O',itemId:'I',productKey:'P',productId:'P',ownerUid:'sales',salesCode:'S',type:'PURCHASING_PO',qty:5,receivedQty:2,fulfillmentType:'DIRECT_SHIP',status:'PARTIAL_RECEIPT',unitCost:123});
 put('orders/O',{status:'cancelled',orderStatus:'cancelled',ownerUid:'sales',salesCode:'S',items:[{itemId:'I',productId:'P'}]});
 put('warehouses/A',{active:true});put('inventory/P',{productKey:'P',incoming:4,onHand:8});put('warehouseStocks/A__P',{productKey:'P',warehouseId:'A',incoming:1,onHand:3});
 const db={projectId:'preview-20135',collection:n=>({doc:id=>({path:n+'/'+id,id})}),runTransaction:async fn=>{
  const writes=[];const tx={get:async r=>{assert.equal(writes.length,0);const v=docs.get(r.path);return {exists:v!==undefined,data:()=>structuredClone(v)};},
   set:(r,d,o)=>writes.push({r,d,o}),update:(r,d)=>writes.push({r,d,o:{merge:true}}),create:(r,d)=>{if(docs.has(r.path))throw Error('collision');writes.push({r,d});}};
  const out=await fn(tx);if(fail)throw Error('rollback');for(const {r,d,o} of writes)put(r.path,{...(o?.merge?docs.get(r.path):{}),...d});return out;
 }};
 return {docs,put,db,setFail:v=>fail=v,snapshot:()=>JSON.stringify([...docs]),run:(data=intent)=>commitCancelledPurchaseKeepStock(db,'U',data,env)};
}
test('strict shared proposal rejects malformed quantities and existing direct incoming instead of masking them',()=>{
 const s={qty:5,receivedQty:2,fulfillmentType:'DIRECT_SHIP',status:'PARTIAL_RECEIPT'};
 assert.equal(planCancelledPurchaseKeepStock(s,intent).remainingQty,3);
 for(const patch of [{receivedQty:6},{receivedQty:-1},{qty:'5'},{qty:1.5},{incomingRegisteredQty:1},{status:'CLOSED'}])assert.throws(()=>planCancelledPurchaseKeepStock({...s,...patch},intent));
});
test('atomic backend adds incoming once, preserves physical stock and writes cost-sanitized receiving mirror',async()=>{
 const f=fixture();assert.equal((await f.run()).status,'applied');const once=f.snapshot();
 assert.equal(f.docs.get('inventory/P').incoming,7);assert.equal(f.docs.get('warehouseStocks/A__P').incoming,4);
 assert.equal(f.docs.get('inventory/P').onHand,8);assert.equal(f.docs.get('warehouseStocks/A__P').onHand,3);
 assert.equal(f.docs.get('receivingSupplyOrders/S').unitCost,undefined);assert.equal(f.docs.get('supplyOrders/S').unitCost,123);
 assert.equal((await f.run()).status,'already-applied');assert.equal(f.snapshot(),once);
 await assert.rejects(f.run({...intent,warehouseId:'B'}),e=>e.code==='already-exists');assert.equal(f.snapshot(),once);
});
test('revoked role, invalid source, negative incoming and late failure leave all documents unchanged',async()=>{
 for(const mutate of [f=>f.put('users/U',{role:'sales'}),f=>f.put('users/U',{role:'purchaser',active:false}),
  f=>f.put('orders/O',{...f.docs.get('orders/O'),status:'active'}),f=>f.put('inventory/P',{productKey:'P',incoming:-1}),f=>f.setFail(true)]){
  const f=fixture();mutate(f);const before=f.snapshot();await assert.rejects(f.run());assert.equal(f.snapshot(),before);
 }
});
test('warehouse purchase marks disposition without registering incoming a second time',async()=>{
 const f=fixture();f.put('supplyOrders/S',{...f.docs.get('supplyOrders/S'),fulfillmentType:'WAREHOUSE',warehouseId:'A',incomingRegisteredQty:3});
 await f.run({...intent,expectedDirect:false});assert.equal(f.docs.get('inventory/P').incoming,4);assert.equal(f.docs.has('inventoryMovements/redirect-S'),false);
});
test('independent gate rejects production/mixed environments and missing Auth before any database access',async()=>{
 assert.equal(cancelledPurchaseProject(env),'preview-20135');
 for(const patch of [{GCLOUD_PROJECT:'yu-shing-company'},{FIRESTORE_EMULATOR_HOST:'localhost:8080'},{FUNCTIONS_EMULATOR:'true'}])assert.equal(cancelledPurchaseProject({...env,...patch}),'');
 class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
 const h=createCancelledPurchaseCallable({onCall:(_,fn)=>fn,HttpsError,env,getDatabase:()=>{throw Error('unexpected db access');}});
 await assert.rejects(h({data:intent}),e=>e.code==='unauthenticated');
});
