'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const {auditQuickPurchase}=require('../functions/quick-purchase-audit');
const {purchaseIntent}=require('../functions/quick-purchase-commit-service');
const {readArguments}=require('../functions/scripts/audit-quick-purchase');
function fixture(){
 const target={orderId:'O',itemId:'I',operationId:'qa-operation-001'},supplyId='manual-O-I';
 const intent=purchaseIntent({...target,qty:1,supplier:'SECRET SUPPLIER',unitCost:735.25});
 const demandId='SALES_ORDER:O:I',movementId='quick-'+target.operationId;
 const identity={productId:'P',productKey:'P',ownerUid:'seller',salesCode:'B'};
 const source={sourceType:'SALES_ORDER',sourceId:'O',sourceItemId:'I',demandId,...identity};
 const records=new Map([
  ['users/buyer',{role:'purchaser',active:true,email:'PRIVATE EMAIL'}],
  ['orders/O',{ownerUid:'seller',salesCode:'B',status:'active',orderStatus:'normal',inventoryReservationStatus:'completed',items:[{
   itemId:'I',productId:'P',warehouseId:'W',qty:1,shortageQty:1,receivedQty:0,supplyOrderedQty:1,
   orderEvents:[{id:movementId,type:'PURCHASING_MANUAL',qty:1,documentNo:'MO-1'}]}]}],
  ['supplyOrders/'+supplyId,{...source,orderId:'O',itemId:'I',type:'PURCHASING_MANUAL',
   fulfillmentType:'WAREHOUSE',warehouseId:'W',status:'ORDERED',qty:1,receivedQty:0,
   incomingRegisteredQty:1,internalNo:'MO-1',supplier:intent.supplier,unitCost:intent.unitCost,
   orderEvents:[{operationId:target.operationId,qty:1,createdByUid:'buyer',supplier:intent.supplier,unitCost:intent.unitCost}]}],
  ['procurementDemands/'+encodeURIComponent(demandId),{...source,status:'ORDERED',requestedQty:1,orderedQty:1,receivedQty:0,remainingToOrderQty:0,remainingToReceiveQty:1}],
  ['purchaseOperations/'+movementId,{...target,type:'PURCHASING_MANUAL',qty:1,uid:'buyer',supplyId,demandId,movementId,
   hash:createHash('sha256').update(JSON.stringify(intent)).digest('hex')}],
  ['inventoryMovements/'+movementId,{type:'purchase_incoming',sourceType:'SUPPLY_ORDER',sourceId:supplyId,
   qty:1,productKey:'P',productId:'P',warehouseId:'W',actorUid:'buyer',purchaseDocumentId:'MO-1'}],
  ['inventory/P',{productKey:'P',productId:'P',onHand:0,reserved:0,incoming:1}],
  ['warehouseStocks/W__P',{productKey:'P',productId:'P',warehouseId:'W',onHand:0,reserved:0,incoming:1}]
 ]);
 const snapshot=path=>({id:path.split('/')[1],exists:records.has(path),data:()=>structuredClone(records.get(path))});
 const db={collection(name){return {
  doc(key){return {path:name+'/'+key};},
  where(field,operator,value){assert.equal(operator,'==');return {limit(max){return {name,field,value,max};}};}
 };},async runTransaction(callback,options){
  assert.deepEqual(options,{readOnly:true});
  return callback({get:async ref=>{
   if(ref.path)return snapshot(ref.path);
   return {docs:[...records.keys()].filter(path=>path.startsWith(ref.name+'/')&&records.get(path)[ref.field]===ref.value)
    .slice(0,ref.max).map(snapshot)};
  },set(){throw Error('audit must never write');},update(){throw Error('audit must never write');},create(){throw Error('audit must never write');}});
 }};
 return {db,target,records,movementId,supplyId};
}
test('snapshot audit resolves the sole original event, checks all links and redacts business data',async()=>{
 const f=fixture(),before=structuredClone(f.records);
 const result=await auditQuickPurchase(f.db,{orderId:'O',itemId:'I'});
 assert.equal(result.status,'CONSISTENT');assert.equal(result.target.operationId,f.target.operationId);
 assert.ok(result.checks.every(c=>c.ok));assert.deepEqual(f.records,before);
 for(const privateValue of ['SECRET SUPPLIER','735.25','PRIVATE EMAIL','buyer'])
  assert.equal(JSON.stringify(result).includes(privateValue),false);
});
test('broken immutable links, missing evidence, duplicate movement and ledger mismatch cannot pass',async()=>{
 const corruptions=[
  f=>f.records.delete('purchaseOperations/'+f.movementId),
  f=>f.records.get('purchaseOperations/'+f.movementId).hash='wrong',
  f=>f.records.get('supplyOrders/'+f.supplyId).sourceId='wrong',
  f=>f.records.get('orders/O').items[0].warehouseId='other',
  f=>f.records.get('procurementDemands/SALES_ORDER%3AO%3AI').productKey='wrong',
  f=>f.records.get('procurementDemands/SALES_ORDER%3AO%3AI').remainingToOrderQty=4,
  f=>f.records.get('orders/O').inventoryReservationStatus='failed',
  f=>f.records.get('orders/O').items[0].supplyOrderedQty=2,
  f=>f.records.get('orders/O').items[0].orderEvents.push({...f.records.get('orders/O').items[0].orderEvents[0]}),
  f=>f.records.get('inventoryMovements/'+f.movementId).actorUid='wrong',
  f=>f.records.set('inventoryMovements/duplicate',{...f.records.get('inventoryMovements/'+f.movementId)}),
  f=>f.records.get('inventory/P').incoming=2,
  f=>f.records.get('inventory/P').incoming=-1,
  f=>f.records.get('warehouseStocks/W__P').warehouseId='wrong',
  f=>f.records.set('warehouseStocks/W2__wrong',{productId:'P',productKey:'wrong',warehouseId:'W2',onHand:0,reserved:0,incoming:1}),
  f=>f.records.get('users/buyer').disabled=true
 ];
 for(const corrupt of corruptions){
  const f=fixture();corrupt(f);const before=structuredClone(f.records);
  assert.equal((await auditQuickPurchase(f.db,f.target)).status,'MISMATCH');
  assert.deepEqual(f.records,before);
 }
});
test('legitimate other warehouse stock is summed without equating company total to one purchase',async()=>{
 const f=fixture();f.records.get('inventory/P').incoming=4;
 f.records.set('warehouseStocks/W2__P',{productKey:'P',productId:'P',warehouseId:'W2',onHand:0,reserved:0,incoming:3});
 assert.equal((await auditQuickPurchase(f.db,f.target)).status,'CONSISTENT');
 f.records.get('warehouseStocks/W2__P').onHand=1;
 assert.equal((await auditQuickPurchase(f.db,f.target)).status,'MISMATCH');
});
test('followup receipt, multiple operations, direct ship and truncated queries are inconclusive',async()=>{
 for(const change of [
  f=>f.records.get('supplyOrders/'+f.supplyId).receivedQty=1,
  f=>f.records.get('supplyOrders/'+f.supplyId).orderEvents.push({operationId:'second-operation'}),
  f=>f.records.get('supplyOrders/'+f.supplyId).fulfillmentType='DIRECT_SHIP',
  f=>{for(let n=0;n<101;n++)f.records.set('warehouseStocks/extra-'+n,{productKey:'P'});}
 ]){
  const f=fixture();change(f);
  assert.equal((await auditQuickPurchase(f.db,f.target)).status,'INCONCLUSIVE');
 }
});
test('CLI rejects execution flags, missing targets, duplicated options and mixed Emulator/live projects',()=>{
 const args=['--project=yu-shing-company','--order=O','--item=I'];
 assert.equal(readArguments(args,{}).project,'yu-shing-company');
 for(const bad of [args.concat('--execute'),args.concat('--order=other'),args.slice(0,2),
  ['--project=other','--order=O','--item=I'],args.concat('--operation=bad/id')])
  assert.throws(()=>readArguments(bad,{}));
 assert.throws(()=>readArguments(args,{FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'}));
 assert.throws(()=>readArguments(['--project=demo-yushin','--order=O','--item=I'],{}));
 assert.equal(readArguments(['--project=demo-yushin','--order=O','--item=I'],{FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080'}).project,'demo-yushin');
});
