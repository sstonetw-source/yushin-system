'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const core=require('../functions/shared/procurement-demand-core');
const {commitV2QuickPurchase,purchaseIntent}=require('../functions/quick-purchase-commit-service');
const {allowQuickPurchaseEmulator,allowPreviewQuickPurchase,createQuickPurchaseCallable}=require('../functions/quick-purchase-callable');
function fixture({directShip=false}={}){
 const orderId='ORDER-1',itemId='I1',productId='P',warehouseId=directShip?'':'W';
 const item={itemId,productId,warehouseId,fulfillmentType:directShip?'DIRECT_SHIP':'WAREHOUSE',
  qty:directShip?7:12,reservedQty:directShip?0:5,shortageQty:directShip?0:7,
  supplyOrderedQty:0,receivedQty:0};
 const order={ownerUid:'seller',salesCode:'B',status:'active',orderStatus:'normal',
  inventoryReservationStatus:'completed',workCategories:['ordering'],items:[item]};
 const demandId=core.demandIdForSource({sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId});
 const demand=core.demandDocument(core.fromSalesOrder({...item,
  requiredSupplyQty:directShip?7:undefined,sourceType:'SALES_ORDER',sourceId:orderId,
  sourceItemId:itemId,sourceItemIndex:0,ownerUid:'seller',salesCode:'B',productKey:productId}));
 const records=new Map([
  ['users/buyer',{role:'purchaser',active:true,name:'Buyer'}],
  ['users/admin',{role:'admin',active:true,name:'Admin'}],
  ['users/seller',{role:'sales',active:true}],
  ['users/off',{role:'purchaser',active:false}],
  ['orders/'+orderId,order],
  ['products/'+productId,{productType:'Goods',active:true}],
  ['procurementDemands/'+encodeURIComponent(demandId),demand]
 ]);
 if(!directShip){
  records.set('warehouses/W',{active:true});
  records.set('inventory/P',{productId:'P',productKey:'P',onHand:5,reserved:2,incoming:0});
  records.set('warehouseStocks/W__P',{productId:'P',productKey:'P',warehouseId:'W',onHand:5,reserved:2,incoming:0});
 }
 const history=[],db={projectId:'demo-yushin',
  collection(name){return {doc(id){return {path:name+'/'+id,id};}};},
  async runTransaction(callback){
   const pending=[];
   const tx={
    async get(ref){assert.equal(pending.length,0,'reads must precede writes');
     return {exists:records.has(ref.path),data:()=>structuredClone(records.get(ref.path))};},
    create(ref,data){pending.push({op:'create',ref,data});},
    set(ref,data){pending.push({op:'set',ref,data});},
    update(ref,data){pending.push({op:'update',ref,data});}
   };
   const result=await callback(tx);
   for(const p of pending){
    if(p.op==='create'&&records.has(p.ref.path))throw Error('duplicate');
    if(p.op==='update'&&!records.has(p.ref.path))throw Error('missing');
   }
   for(const p of pending){
    records.set(p.ref.path,p.op==='update'?{...records.get(p.ref.path),...p.data}:structuredClone(p.data));
    history.push(p.ref.path);
   }
   return result;
  }
 };
 const data={operationId:'op-20261025-001',orderId,itemId,qty:4,supplier:'Vendor',unitCost:19.99};
 return {db,records,history,data,demandId};
}
test('quick purchase backend commits one atomic supplier demand, order and incoming ledger',async()=>{
 const x=fixture(),res=await commitV2QuickPurchase(x.db,'buyer',x.data);
 assert.equal(res.status,'committed');
 assert.equal(res.committedQty,4);
 assert.equal(x.records.get('orders/ORDER-1').items[0].supplyOrderedQty,4);
 assert.equal(x.records.get('procurementDemands/'+encodeURIComponent(x.demandId)).orderedQty,4);
 assert.equal(x.records.get('inventory/P').incoming,4);
 assert.equal(x.records.get('warehouseStocks/W__P').incoming,4);
 assert.equal(x.records.get('inventory/P').onHand,5);
 assert.equal(x.records.get('warehouseStocks/W__P').reserved,2);
 assert.equal(x.records.get('inventoryMovements/quick-'+x.data.operationId).qty,4);
 assert.equal(x.records.get('supplyOrders/'+res.supplyId).unitCost,19.99);
 const count=x.history.length;
 const retry=await commitV2QuickPurchase(x.db,'buyer',x.data);
 assert.equal(retry.status,'already-applied');
 assert.equal(x.history.length,count);
 await assert.rejects(commitV2QuickPurchase(x.db,'admin',x.data),{code:'already-exists'});
 await assert.rejects(commitV2QuickPurchase(x.db,'buyer',{...x.data,qty:3}),{code:'already-exists'});
 assert.equal(x.history.length,count);
});
test('quick purchase replay fails closed when source or incoming evidence is missing or altered',async()=>{
 const mutations=[
  x=>{x.records.get('orders/ORDER-1').items[0].orderEvents=[];},
  x=>{x.records.delete('procurementDemands/'+encodeURIComponent(x.demandId));},
  x=>{x.records.get('procurementDemands/'+encodeURIComponent(x.demandId)).sourceId='forged-order';},
  x=>{x.records.get('procurementDemands/'+encodeURIComponent(x.demandId)).productKey='forged-product';},
  x=>{x.records.get('purchaseOperations/quick-'+x.data.operationId).movementId='wrong';},
  x=>{x.records.delete('inventoryMovements/quick-'+x.data.operationId);},
  x=>{x.records.get('inventoryMovements/quick-'+x.data.operationId).qty=3;},
  x=>{x.records.get('inventoryMovements/quick-'+x.data.operationId).sourceId='wrong';},
  x=>{x.records.get('inventoryMovements/quick-'+x.data.operationId).warehouseId='wrong';},
  x=>{x.records.get('inventoryMovements/quick-'+x.data.operationId).actorUid='wrong';}
 ];
 for(const mutate of mutations){
  const x=fixture();
  await commitV2QuickPurchase(x.db,'buyer',x.data);
  const writes=x.history.length;
  mutate(x);
  await assert.rejects(commitV2QuickPurchase(x.db,'buyer',x.data),{code:'failed-precondition'});
  assert.equal(x.history.length,writes,'failed replay must not write a second ledger');
 }
 const direct=fixture({directShip:true});
 await commitV2QuickPurchase(direct.db,'buyer',direct.data);
 const count=direct.history.length;
 assert.equal((await commitV2QuickPurchase(direct.db,'buyer',direct.data)).status,'already-applied');
 assert.equal(direct.history.length,count);
 direct.records.get('orders/ORDER-1').items[0].orderEvents=[];
 await assert.rejects(commitV2QuickPurchase(direct.db,'buyer',direct.data),{code:'failed-precondition'});
 assert.equal(direct.history.length,count);
});
test('quick purchase backend enforces role, demand, supplier and stock integrity without partial writes',async()=>{
 for(const who of ['seller','off','unknown']){
  const x=fixture();await assert.rejects(commitV2QuickPurchase(x.db,who,x.data),{code:'permission-denied'});
  assert.equal(x.history.length,0);
 }
 for(const change of [x=>{x.data.qty=8;},x=>{x.records.delete('warehouseStocks/W__P');},
  x=>{x.records.get('inventory/P').incoming=-1;},
  x=>{x.records.get('inventory/P').productKey='wrong-product';},
  x=>{x.records.get('warehouseStocks/W__P').productId='wrong-product';},
  x=>{x.records.get('orders/ORDER-1').orderStatus='cancelled';},
  x=>{x.records.get('orders/ORDER-1').items[0].procurementType='SALES_SELF_ORDER';},
  x=>{x.records.get('orders/ORDER-1').procurementType='SALES_SELF_ORDER';},
  x=>{x.records.get('procurementDemands/'+encodeURIComponent(x.demandId)).orderedQty=2;}]){
  const x=fixture();change(x);
  await assert.rejects(commitV2QuickPurchase(x.db,'buyer',x.data),{code:'failed-precondition'});
  assert.equal(x.history.length,0);
 }
});
test('quick purchase backend direct-ship updates only cost-free mirror and never warehouse incoming',async()=>{
 const x=fixture({directShip:true}),result=await commitV2QuickPurchase(x.db,'buyer',x.data);
 assert.equal(result.status,'committed');
 assert.equal(x.records.get('supplyOrders/'+result.supplyId).incomingRegisteredQty,0);
 const view=x.records.get('receivingSupplyOrders/'+result.supplyId);
 assert.equal(view.qty,4);assert.equal(Object.hasOwn(view,'unitCost'),false);
 assert.equal(x.records.get('orders/ORDER-1').workCategories.includes('ordering'),true);
 assert.equal(x.history.some(path=>path.startsWith('inventory/')),false);
 assert.equal(x.history.some(path=>path.startsWith('inventoryMovements/')),false);
});
test('quick purchase strict request rejects forged role, bad quantity, invalid cost and missing operation id',()=>{
 const {data}=fixture();
 assert.deepEqual(purchaseIntent(data),data);
 for(const bad of [{...data,role:'admin'},{...data,qty:0},{...data,qty:2.5},
  {...data,unitCost:-1},{...data,unitCost:19.999},{...data,operationId:'x'},
  {...data,orderId:'../orders'}, {...data,supplier:' '}])
  assert.throws(()=>purchaseIntent(bad),{code:'invalid-argument'});
});
test('quick purchase callable is strictly demo Emulator only and never touches production',async()=>{
 const demo={GCLOUD_PROJECT:'demo-yushin',FUNCTIONS_EMULATOR:'true',
  ENABLE_QUICK_PURCHASE_EMULATOR:'true',FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',
  FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'};
 assert.equal(allowQuickPurchaseEmulator(demo),true);
 for(const change of [{GCLOUD_PROJECT:'yu-shing-company'},{FUNCTIONS_EMULATOR:'false'},
  {ENABLE_QUICK_PURCHASE_EMULATOR:'false'},{FIRESTORE_EMULATOR_HOST:'remote:8080'},
  {FIREBASE_AUTH_EMULATOR_HOST:''}])
  assert.equal(allowQuickPurchaseEmulator({...demo,...change}),false);
 class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
 const make=(env,db)=>createQuickPurchaseCallable({onCall:(_options,handler)=>handler,
  HttpsError,getDatabase:()=>db,env});
 const x=fixture();
 await assert.rejects(make({...demo,GCLOUD_PROJECT:'yu-shing-company'},x.db)
  ({auth:{uid:'buyer'},data:x.data}),{code:'failed-precondition'});
 await assert.rejects(make(demo,{...x.db,projectId:'yu-shing-company'})
  ({auth:{uid:'buyer'},data:x.data}),{code:'failed-precondition'});
 await assert.rejects(make(demo,x.db)({data:x.data}),{code:'unauthenticated'});
 assert.equal(x.history.length,0);
 const result=await make(demo,x.db)({auth:{uid:'buyer'},data:x.data});
 assert.equal(result.status,'committed');
});
test('preview quick purchase remains disabled by default and cannot be used in production',async()=>{
 const preview={GCLOUD_PROJECT:'preview-20135',ENABLE_PREVIEW_QUICK_PURCHASE:'true'};
 assert.equal(allowPreviewQuickPurchase(preview),true);
 for(const bad of [{GCLOUD_PROJECT:'yu-shing-company'},{GCLOUD_PROJECT:'demo-yushin'},
  {ENABLE_PREVIEW_QUICK_PURCHASE:'false'},{FUNCTIONS_EMULATOR:'true'},
  {FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'},{FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'}])
  assert.equal(allowPreviewQuickPurchase({...preview,...bad}),false);
 class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
 const make=(env,db)=>createQuickPurchaseCallable({onCall:(_options,handler)=>handler,
  HttpsError,getDatabase:()=>db,env});
 const x=fixture(),previewDb={...x.db,projectId:'preview-20135'};
 await assert.rejects(make({...preview,GCLOUD_PROJECT:'yu-shing-company'},previewDb)
  ({auth:{uid:'buyer'},data:x.data}),{code:'failed-precondition'});
 await assert.rejects(make(preview,x.db)({auth:{uid:'buyer'},data:x.data}),{code:'failed-precondition'});
 await assert.rejects(make(preview,previewDb)({data:x.data}),{code:'unauthenticated'});
 await assert.rejects(make(preview,previewDb)({auth:{uid:'seller'},data:x.data}),{code:'permission-denied'});
 assert.equal(x.history.length,0);
 const result=await make(preview,previewDb)({auth:{uid:'buyer'},data:x.data});
 assert.equal(result.status,'committed');
 assert.equal((await make(preview,previewDb)({auth:{uid:'buyer'},data:x.data})).status,'already-applied');
});
