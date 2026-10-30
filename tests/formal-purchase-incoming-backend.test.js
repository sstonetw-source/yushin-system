'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {registerFormalPurchaseIncoming,formalIncomingGate}=require('../functions/formal-purchase-incoming-service');
const env={GCLOUD_PROJECT:'demo-yushin',FUNCTIONS_EMULATOR:'true',
 ENABLE_V2_PO_INCOMING_EMULATOR:'true',FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',
 FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'};
function fixture(){
 const docs=new Map();const put=(c,id,data)=>docs.set(c+'/'+id,structuredClone(data));
 put('users','buyer',{role:'purchaser',active:true,name:'Buyer'});
 put('products','P',{active:true,productType:'Goods',itemCode:'P'});
 const lines=[{orderId:'O',itemId:'I1',productId:'P',productKey:'P',warehouseId:'A',qty:2},
  {orderId:'O',itemId:'I2',productId:'P',productKey:'P',warehouseId:'A',qty:1},
  {orderId:'O',itemId:'I3',productId:'P',productKey:'P',warehouseId:'B',qty:4}];
 put('orders','O',{items:lines.map(l=>({itemId:l.itemId,productId:'P',supplyOrderedQty:l.qty}))});
 put('purchaseOrders','PO-1',{poNo:'PO-1',status:'ORDERED',serverCommitHash:'hash',
  documentOnly:false,items:lines,supplyOrderIds:lines.map((_,i)=>'po-PO-1-'+i)});
 lines.forEach((l,i)=>{
  const supply={type:'PURCHASING_PO',status:'ORDERED',
  purchaseDocumentId:'PO-1',sourceType:'SALES_ORDER',orderId:'O',itemId:l.itemId,productId:'P',
  productKey:'P',sourceId:'O',sourceItemId:l.itemId,qty:l.qty,receivedQty:0,incomingRegisteredQty:0,warehouseId:l.warehouseId,
  fulfillmentType:'WAREHOUSE',brand:'B',brandId:'B',itemCode:'P',itemName:'Product'};
  put('supplyOrders','po-PO-1-'+i,{...supply,unitCost:10});
  if(i===1)put('receivingSupplyOrders','po-PO-1-'+i,supply);
 });
 for(const id of ['A','B'])put('warehouses',id,{active:true,systemCustody:false});
 put('inventory','P',{productKey:'P',productId:'P',onHand:5,reserved:2,incoming:0,lots:['LOT']});
 put('warehouseStocks','A__P',{productKey:'P',productId:'P',warehouseId:'A',onHand:3,reserved:1,incoming:0});
 put('warehouseStocks','B__P',{productKey:'P',productId:'P',warehouseId:'B',onHand:2,reserved:1,incoming:0});
 const db={projectId:'demo-yushin',collection:c=>({doc:id=>({id,path:c+'/'+id})}),
  async runTransaction(fn){
   const staged=[];
   const tx={async get(ref){const row=docs.get(ref.path);return {exists:row!==undefined,data:()=>structuredClone(row)};},
    create(ref,data){if(docs.has(ref.path))throw Error('already exists');staged.push([ref.path,structuredClone(data),'create']);},
    update(ref,data){if(!docs.has(ref.path))throw Error('not found');staged.push([ref.path,structuredClone(data),'update']);},
    set(ref,data){staged.push([ref.path,structuredClone(data),'update']);}};
   const result=await fn(tx);
   staged.forEach(([path,data,action])=>{if(action==='create')docs.set(path,data);
    else docs.set(path,{...(docs.get(path)||{}),...data});});
   return result;
  }};
 return {docs,db,put};
}
test('PO incoming backend requires local isolated demo and an explicit opt-in',()=>{
 assert.equal(formalIncomingGate({}), '');
 assert.equal(formalIncomingGate({...env,GCLOUD_PROJECT:'yu-shing-company'}),'');
 assert.equal(formalIncomingGate({...env,FUNCTIONS_EMULATOR:'false'}),'');
 assert.equal(formalIncomingGate(env),'demo-yushin');
});
test('one PO atomically credits shared-product company, two warehouses and three supply movements once',async()=>{
 const x=fixture(),first=await registerFormalPurchaseIncoming(x.db,'buyer',{poNo:'PO-1'},env);
 assert.equal(first.status,'applied');assert.equal(first.details.length,3);
 assert.deepEqual([x.docs.get('inventory/P').incoming,x.docs.get('warehouseStocks/A__P').incoming,
  x.docs.get('warehouseStocks/B__P').incoming],[7,3,4]);
 assert.deepEqual(x.docs.get('inventory/P').lots,['LOT']);
 assert.deepEqual([x.docs.get('inventory/P').onHand,x.docs.get('inventory/P').reserved],[5,2]);
 assert.equal([...x.docs.keys()].filter(k=>k.startsWith('inventoryMovements/po-incoming-')).length,3);
 assert.deepEqual([0,1,2].map(i=>x.docs.get('supplyOrders/po-PO-1-'+i).incomingRegisteredQty),[2,1,4]);
 assert.deepEqual([0,1,2].map(i=>x.docs.get('receivingSupplyOrders/po-PO-1-'+i).incomingRegisteredQty),[2,1,4]);
 assert.equal(x.docs.get('receivingSupplyOrders/po-PO-1-0').unitCost,undefined);
 const before=structuredClone([...x.docs.entries()]);
 assert.equal((await registerFormalPurchaseIncoming(x.db,'buyer',{poNo:'PO-1'},env)).status,'already-applied');
 assert.deepEqual([...x.docs.entries()],before);
});
test('missing last source, previous client incoming and unauthorized actor all leave PO wholly unchanged',async()=>{
 for(const mode of ['supply','already','permission','warehouse','quantity','foreign','tampered-mirror']){
  const x=fixture();
  if(mode==='supply')x.docs.delete('supplyOrders/po-PO-1-2');
  if(mode==='already')x.docs.get('supplyOrders/po-PO-1-1').incomingRegisteredQty=1;
  if(mode==='permission')x.docs.get('users/buyer').role='sales';
  if(mode==='warehouse')x.docs.get('warehouses/B').systemCustody=true;
  if(mode==='quantity')x.docs.get('inventory/P').incoming=-1;
  if(mode==='foreign')x.db.projectId='yu-shing-company';
  if(mode==='tampered-mirror')x.docs.get('receivingSupplyOrders/po-PO-1-1').productKey='FORGED';
  const before=structuredClone([...x.docs.entries()]);
  await assert.rejects(registerFormalPurchaseIncoming(x.db,'buyer',{poNo:'PO-1'},env));
  assert.deepEqual([...x.docs.entries()],before,mode);
 }
});
test('replay remains tied to original actor and immutable PO, forbids changed source',async()=>{
 const x=fixture();await registerFormalPurchaseIncoming(x.db,'buyer',{poNo:'PO-1'},env);
 x.put('users','other',{role:'admin',active:true});
 await assert.rejects(registerFormalPurchaseIncoming(x.db,'other',{poNo:'PO-1'},env),/憑證/);
 await assert.rejects(registerFormalPurchaseIncoming(x.db,'buyer',{poNo:'PO-1',newOperationId:'different'},env));
});
