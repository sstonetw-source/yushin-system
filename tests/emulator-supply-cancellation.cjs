'use strict';
// Actual Admin SDK / Firestore Emulator transaction tests. Never contact live data.
const {test}=require('node:test'),assert=require('node:assert/strict');
const admin=require('firebase-admin');
const demand=require('../functions/shared/procurement-demand-core');
const {commitSupplyCancellation}=require('../functions/supply-cancellation-service');
const project='demo-yushin';
const env={GCLOUD_PROJECT:project,FUNCTIONS_EMULATOR:'true',
 FIRESTORE_EMULATOR_HOST:'localhost:8080',FIREBASE_AUTH_EMULATOR_HOST:'localhost:9099',
 ENABLE_SUPPLY_CANCELLATION_EMULATOR:'true'};
let app,db;
test.before(()=>{
 assert.match(process.env.FIRESTORE_EMULATOR_HOST||'',/^(localhost|127\.0\.0\.1):[0-9]+$/,
  'Supply cancellation integration MUST use local Firestore Emulator');
 assert.equal(process.env.GCLOUD_PROJECT||process.env.GCP_PROJECT,project);
 app=admin.initializeApp({projectId:project},'supplier-cancellation-emulator-test');
 db=admin.firestore(app);
});
test.after(async()=>{if(app)await app.delete();});
const get=path=>db.doc(path).get().then(s=>s.exists?s.data():null);
async function seed(tag){
 const prefix='supplier-cancel-'+tag,poId=prefix+'-PO',user=prefix+'-buyer',ids=[];
 const batch=db.batch(),put=(path,value)=>batch.set(db.doc(path),value);
 put('users/'+user,{active:true,role:'purchaser',name:'Emulator Buyer'});
 put('users/'+prefix+'-sales',{active:true,role:'sales',name:'Emulator Sales'});
 const lines=[];
 for(let i=0;i<2;i++){
  const orderId=prefix+'-O'+i,supplyId=prefix+'-S'+i,product=prefix+'-P'+i,
   warehouseId=prefix+'-W'+i,itemId='item',key=product;
  const demandId=demand.demandIdForSource({sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId});
  const source={type:'PURCHASING_PO',method:'PURCHASING_PO',purchaseDocumentId:poId,
   orderId,itemId,sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId,
   demandId,productId:product,productKey:key,warehouseId,fulfillmentType:'WAREHOUSE',
   ownerUid:user,salesCode:'S1',qty:5,receivedQty:2,incomingRegisteredQty:3,
   status:'PARTIAL_RECEIPT',unitCost:14};
  put('supplyOrders/'+supplyId,source);
  put('receivingSupplyOrders/'+supplyId,{...source,unitCost:undefined});
  put('orders/'+orderId,{ownerUid:user,salesCode:'S1',status:'active',
   workCategories:['arrival'],items:[{itemId,productId:product,qty:8,orderedQty:8,
    reservedQty:0,shortageQty:8,supplyOrderedQty:5,receivedQty:2}]});
  put('procurementDemands/'+encodeURIComponent(demandId),demand.demandDocument({
   demandId,sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId,
   productId:product,productKey:key,warehouseId,ownerUid:user,salesCode:'S1',
   requestedQty:8,orderedQty:5,receivedQty:2}));
  put('inventory/'+encodeURIComponent(key),{productId:product,productKey:key,
   onHand:4,reserved:1,incoming:3});
  put('warehouseStocks/'+encodeURIComponent(warehouseId)+'__'+encodeURIComponent(key),{
   productId:product,productKey:key,warehouseId,onHand:4,reserved:1,incoming:3});
  lines.push({orderId,itemId,productId:product,qty:5,unitPrice:14});ids.push(supplyId);
 }
 put('purchaseOrders/'+poId,{poNo:poId,status:'ORDERED',documentOnly:false,
  purchaseType:'order',items:lines,supplyOrderIds:ids,serverCommitHash:'emulator-seeded'});
 await batch.commit();
 const single={operationId:prefix+'-single',poId,supplyId:ids[0],reason:'測試停止未到貨供應'};
 const whole={operationId:prefix+'-whole',poId,reason:'測試整張採購單停止'};
 const run=(userId,input,wholePo=false)=>commitSupplyCancellation(db,userId,input,{whole:wholePo,env});
 return {prefix,poId,user,ids,lines,single,whole,run};
}
test('real Firestore whole PO is atomic, replay-safe, and updates all linked ledgers',async()=>{
 const f=await seed('atomic');
 const first=await f.run(f.user,f.whole,true);
 assert.equal(first.status,'applied');assert.equal(first.cancelledQty,6);
 assert.equal((await get('purchaseOrders/'+f.poId)).status,'CLOSED');
 for(let i=0;i<2;i++){
  const row=f.lines[i],supply=await get('supplyOrders/'+f.ids[i]);
  assert.equal(supply.status,'CLOSED');assert.equal(supply.incomingRegisteredQty,0);
  assert.equal((await get('orders/'+row.orderId)).items[0].supplyOrderedQty,2);
  assert.equal((await get('inventory/'+row.productId)).incoming,0);
  assert.equal((await get('warehouseStocks/'+f.prefix+'-W'+i+'__'+row.productId)).incoming,0);
  const movement=await get('inventoryMovements/supply-cancel-'+f.whole.operationId+'-'+i);
  assert.equal(movement.qty,-3);assert.equal(movement.actorUid,f.user);
 }
 assert.equal((await f.run(f.user,f.whole,true)).status,'already-applied');
 await assert.rejects(f.run(f.user,{...f.whole,reason:'另一個原因'},true),e=>e.code==='already-exists');
 assert.equal((await get('inventory/'+f.lines[0].productId)).incoming,0);
});
test('real Firestore rejects bad last-line incoming without partial PO updates',async()=>{
 const f=await seed('rollback');
 await db.doc('warehouseStocks/'+f.prefix+'-W1__'+f.lines[1].productId).update({incoming:1});
 await assert.rejects(f.run(f.user,f.whole,true),e=>e.code==='failed-precondition');
 assert.equal((await get('supplyOrders/'+f.ids[0])).status,'PARTIAL_RECEIPT');
 assert.equal((await get('inventory/'+f.lines[0].productId)).incoming,3);
 assert.equal((await get('orders/'+f.lines[0].orderId)).items[0].supplyOrderedQty,5);
 assert.equal(await get('purchaseOperations/supply-cancel-'+f.whole.operationId),null);
 assert.equal((await get('purchaseOrders/'+f.poId)).status,'ORDERED');
});
test('real Firestore authenticated role record and concurrent same-ID retries never double-debit',async()=>{
 const f=await seed('races');
 await assert.rejects(f.run(f.prefix+'-sales',f.single),e=>e.code==='permission-denied');
 assert.equal((await get('inventory/'+f.lines[0].productId)).incoming,3);
 const results=await Promise.all([f.run(f.user,f.single),f.run(f.user,f.single)]);
 assert.deepEqual(results.map(row=>row.status).sort(),['already-applied','applied']);
 assert.equal((await get('inventory/'+f.lines[0].productId)).incoming,0);
 assert.equal((await get('inventory/'+f.lines[1].productId)).incoming,3);
 assert.equal((await get('orders/'+f.lines[0].orderId)).items[0].supplyOrderedQty,2);
});
