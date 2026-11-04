'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {registerFormalPurchaseIncoming,formalIncomingGate}=require('../functions/formal-purchase-incoming-service');
const {commitV2FormalPurchase}=require('../functions/formal-purchase-commit-service');
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

async function confirmedDirectStock(){
 const x=fixture(),poNo='PO-STOCK',supplier='Stock Vendor',poDate='2026-11-04';
 const snapshot={supplierId:'SUP',supplierName:supplier,purchaseHeaderName:supplier,email:'stock@example.test',leadTimeDays:5};
 const document={company:'yushin',supplierSnapshot:snapshot,expectedDate:'2026-11-09',
  expectedDateSource:'manual',lineScheduleDates:['2026-11-09']};
 const item={sourceType:'STOCK_REPLENISHMENT',orderId:'',itemId:'',productId:'P',warehouseId:'A',
  fulfillmentType:'WAREHOUSE',itemCode:'P',itemName:'Product',brand:'Test',qty:2,unitPrice:12,
  scheduleDate:'2026-11-09'};
 x.put('purchaseOrders',poNo,{poNo,poDate,purchaseType:'stock',supplierName:supplier,vendorName:supplier,
  company:'yushin',supplierSnapshot:snapshot,expectedDate:document.expectedDate,
  expectedDateSource:'manual',status:'DRAFT',documentOnly:true,documentRevision:1,
  createdByUid:'buyer',createdByRole:'purchaser',items:[item]});
 const input={poNo,poDate,supplier,document,documentRevision:1,
  items:[{sourceType:'STOCK_REPLENISHMENT',productId:'P',warehouseId:'A',qty:2,unitCost:12}]};
 const committed=await commitV2FormalPurchase(x.db,'buyer',input);
 assert.equal(committed.status,'committed');
 return {...x,poNo,input};
}
test('direct-stock PO has no source order yet confirms, books incoming and remains idempotent end-to-end',async()=>{
 const x=await confirmedDirectStock();
 const sourceId='MANUAL_PO:PO-STOCK:0',demandId='STOCK_REPLENISHMENT:'+sourceId;
 const supply=x.docs.get('supplyOrders/po-PO-STOCK-0');
 assert.equal(supply.orderId,'');assert.equal(supply.sourceType,'STOCK_REPLENISHMENT');
 assert.equal(supply.sourceId,sourceId);assert.equal(supply.demandId,demandId);
 assert.equal(x.docs.get('procurementDemands/'+encodeURIComponent(demandId)).orderedQty,2);
 const incoming=await registerFormalPurchaseIncoming(x.db,'buyer',{poNo:x.poNo},env);
 assert.equal(incoming.status,'applied');
 assert.equal(x.docs.get('inventory/P').incoming,2);
 assert.equal(x.docs.get('warehouseStocks/A__P').incoming,2);
 assert.equal(x.docs.get('supplyOrders/po-PO-STOCK-0').incomingRegisteredQty,2);
 assert.equal(x.docs.get('receivingSupplyOrders/po-PO-STOCK-0').unitCost,undefined);
 const after=structuredClone([...x.docs]);
 assert.equal((await commitV2FormalPurchase(x.db,'buyer',x.input)).status,'already-applied');
 assert.equal((await registerFormalPurchaseIncoming(x.db,'buyer',{poNo:x.poNo},env)).status,'already-applied');
 assert.deepEqual([...x.docs],after);
});
test('direct-stock incoming refuses missing or tampered demand and stale supply without any partial write',async()=>{
 for(const mode of ['missing-demand','changed-demand','changed-supply','changed-warehouse','role']){
  const x=await confirmedDirectStock(),demandId='STOCK_REPLENISHMENT:MANUAL_PO:PO-STOCK:0';
  const key='procurementDemands/'+encodeURIComponent(demandId);
  if(mode==='missing-demand')x.docs.delete(key);
  if(mode==='changed-demand')x.docs.get(key).orderedQty=1;
  if(mode==='changed-supply')x.docs.get('supplyOrders/po-PO-STOCK-0').sourceId='OTHER';
  if(mode==='changed-warehouse')x.docs.get('warehouses/A').systemCustody=true;
  if(mode==='role')x.docs.get('users/buyer').role='sales';
  const before=structuredClone([...x.docs]);
  await assert.rejects(registerFormalPurchaseIncoming(x.db,'buyer',{poNo:x.poNo},env));
  assert.deepEqual([...x.docs],before,mode);
 }
});

const production={GCLOUD_PROJECT:'yu-shing-company',ENABLE_PRODUCTION_FORMAL_PURCHASE:'true'};
const {createPreviewFormalPurchaseCallable}=require('../functions/formal-purchase-preview-callable');
class HttpsError extends Error{constructor(code,message){super(message);this.code=code;}}
function productionHandler(x,environment=production){
 return createPreviewFormalPurchaseCallable({onCall:(_options,handler)=>handler,HttpsError,
  getDatabase:()=>x.db,env:environment});
}
test('production incoming checkpoint atomically credits the same company/two-warehouse ledger and replays once',async()=>{
 const x=fixture();x.db.projectId='yu-shing-company';
 const handler=productionHandler(x),request={auth:{uid:'buyer'},data:{action:'register-incoming',poNo:'PO-1'}};
 const first=await handler(request);
 assert.equal(first.status,'applied');
 assert.deepEqual([x.docs.get('inventory/P').incoming,x.docs.get('warehouseStocks/A__P').incoming,
  x.docs.get('warehouseStocks/B__P').incoming],[7,3,4]);
 const before=structuredClone([...x.docs.entries()]);
 assert.equal((await handler(request)).status,'already-applied');
 assert.deepEqual([...x.docs.entries()],before);
});
test('production incoming refuses wrong environment, actor, extra client facts and invalid last source with zero writes',async()=>{
 for(const mode of ['disabled','emulator','foreign','unsigned','role','extra','source']){
  const x=fixture();x.db.projectId='yu-shing-company';
  const environment={...production},request={auth:{uid:'buyer'},data:{action:'register-incoming',poNo:'PO-1'}};
  if(mode==='disabled')environment.ENABLE_PRODUCTION_FORMAL_PURCHASE='false';
  if(mode==='emulator')environment.FIRESTORE_EMULATOR_HOST='127.0.0.1:8080';
  if(mode==='foreign')x.db.projectId='preview-20135';
  if(mode==='unsigned')delete request.auth;
  if(mode==='role')x.docs.get('users/buyer').role='warehouse';
  if(mode==='extra')request.data.qty=7;
  if(mode==='source')x.docs.delete('supplyOrders/po-PO-1-2');
  const before=structuredClone([...x.docs.entries()]);
  await assert.rejects(productionHandler(x,environment)(request));
  assert.deepEqual([...x.docs.entries()],before,mode);
 }
});
