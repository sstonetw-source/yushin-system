'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('src/services/self-order-supply.js','utf8');
function fixture({retry=false,loseResponse=false,failCommit=false,role='sales',pending=false}={}){
 const docs=new Map([['orders/O',{ownerUid:'U',status:'normal',inventoryReservationStatus:pending?'pending':'completed',items:[
  {itemId:'I',productId:'P',qty:10,shortageQty:10,supplyOrderedQty:0,procurementType:'SALES_SELF_ORDER',fulfillmentType:'WAREHOUSE'}]}]]);
 const ref=(col,id)=>({id,path:col+'/'+id});let writes=0,lost=false;
 const c=vm.createContext({currentUser:{uid:'U'},currentUserRole:role,currentUserCode:'S',currentUserName:'Sales',
  db:{collection:col=>({doc:id=>ref(col,id)})},supplyOrdersCollection:()=>({doc:id=>ref('supplyOrders',id)}),
  canBusinessSelfOrder:()=>['sales','engineer','admin'].includes(c.currentUserRole),canCreatePurchaseOrderCapability:()=>c.currentUserRole==='purchaser',
  orderInventorySyncIncomplete:o=>o.inventoryReservationStatus==='pending',normalizedOrderStatus:o=>o.status,
  normalizedOrderItems:o=>structuredClone(o.items),defaultWarehouse:()=>({id:'W'}),deliveryActor:()=> 'Actor',
  procurementDemandForOrderItem:(_o,i)=>({demandId:'D',requestedQty:i.shortageQty,orderedQty:i.supplyOrderedQty||0,
    remainingToOrderQty:Math.max(0,i.shortageQty-(i.supplyOrderedQty||0))}),
  procurementDemandRef:id=>ref('procurementDemands',id),procurementDemandDocument:d=>d,
  inventoryProductKey:i=>i.productId,orderWorkIndexFields:()=>({workCategory:'arrival'}),
  YushinSupply:require('../modules/supply-core'),YushinProcurementDemand:require('../modules/procurement-demand-core'),
  runRoleTransaction:async callback=>{
    const staged=[];const tx={get:async r=>({exists:docs.has(r.path),data:()=>structuredClone(docs.get(r.path))}),
      set:(r,d)=>staged.push([r,d,false]),update:(r,d)=>staged.push([r,d,true])};
    await callback(tx);if(retry){staged.length=0;await callback(tx);}
    if(failCommit)throw Error('commit failed');
    for(const [r,data,merge] of staged)docs.set(r.path,{...(merge?docs.get(r.path):{}),...data});
    if(staged.length)writes++;
    if(loseResponse&&!lost){lost=true;throw Error('response lost');}
  }
 });
 vm.runInContext(source,c);return {c,docs,writes:()=>writes};
}
const details=(patch={})=>({supplier:'Vendor',qty:3,unitCost:0,orderDate:'2026-10-16',notes:'',operationId:'MANUAL-1',...patch});
test('manual and initial entries share the same demand and order projection, with zero actual cost allowed',async()=>{
 const manual=fixture(),initial=fixture();
 await manual.c.commitSelfOrderSupply('O','I',details());
 await initial.c.registerInitialSelfOrderSupply('O','I',details());
 for(const f of [manual,initial]){
  assert.equal(f.docs.get('orders/O').items[0].supplyOrderedQty,3);
  assert.equal(f.docs.get('procurementDemands/D').orderedQty,3);
  const supply=[...f.docs].find(([k])=>k.startsWith('supplyOrders/'))[1];
  assert.equal(supply.unitCost,0);assert.equal(supply.fulfillmentType,'WAREHOUSE');assert.equal(supply.receivedQty,0);
  assert.equal([...f.docs.keys()].some(k=>k.startsWith('inventory/')),false);
 }
});
test('lost manual response and callback retries never create a second commitment for the same intent',async()=>{
 for(const options of [{retry:true},{loseResponse:true}]){
  const f=fixture(options);
  if(options.loseResponse)await assert.rejects(f.c.commitSelfOrderSupply('O','I',details()),/response lost/);
  else await f.c.commitSelfOrderSupply('O','I',details());
  const result=await f.c.commitSelfOrderSupply('O','I',details());
  assert.equal(result.internalNo,f.docs.get('supplyOrders/MANUAL-1').internalNo);
  assert.equal(f.writes(),1);assert.equal(f.docs.get('orders/O').items[0].supplyOrderedQty,3);
  assert.equal([...f.docs.keys()].filter(k=>k.startsWith('supplyOrders/')).length,1);
 }
});
test('same operation identity with changed supplier, quantity, price, date or notes fails before any additional writes',async()=>{
 for(const patch of [{supplier:'Other'},{qty:2},{unitCost:5},{orderDate:'2026-10-15'},{notes:'Changed'}]){
  const f=fixture();await f.c.commitSelfOrderSupply('O','I',details());
  await assert.rejects(f.c.commitSelfOrderSupply('O','I',details(patch)),/識別碼衝突/);assert.equal(f.writes(),1);
 }
});
test('a failed transaction commits neither supply, demand nor source-order progress',async()=>{
 const f=fixture({failCommit:true});await assert.rejects(f.c.commitSelfOrderSupply('O','I',details()),/commit failed/);
 assert.equal(f.docs.has('supplyOrders/MANUAL-1'),false);assert.equal(f.docs.has('procurementDemands/D'),false);
 assert.equal(f.docs.get('orders/O').items[0].supplyOrderedQty,0);
});
test('manual permission and synchronization restrictions remain distinct from initial creation synchronization',async()=>{
 const buyer=fixture({role:'purchaser'});
 await assert.rejects(buyer.c.commitSelfOrderSupply('O','I',details()),/負責業務/);
 await buyer.c.registerInitialSelfOrderSupply('O','I',details());assert.equal(buyer.writes(),1);
 const pending=fixture({pending:true});
 await assert.rejects(pending.c.commitSelfOrderSupply('O','I',details()),/尚未同步/);
 await pending.c.registerInitialSelfOrderSupply('O','I',details());assert.equal(pending.writes(),1);
});
test('invalid inputs, insufficient demand and cancelled orders create no supplier commitments',async()=>{
 for(const patch of [{qty:0},{qty:11},{unitCost:-1},{orderDate:'2026-02-30'},{operationId:''}]){
  const f=fixture();await assert.rejects(f.c.commitSelfOrderSupply('O','I',details(patch)));assert.equal(f.writes(),0);
 }
 const f=fixture();f.docs.get('orders/O').status='cancelled';
 await assert.rejects(f.c.commitSelfOrderSupply('O','I',details()),/已取消/);assert.equal(f.writes(),0);
});
test('direct self-order and repeated partial orders preserve the source item without inventing physical arrival',async()=>{
 const f=fixture();f.docs.get('orders/O').items[0].fulfillmentType='DIRECT_SHIP';
 await f.c.commitSelfOrderSupply('O','I',details());
 await f.c.commitSelfOrderSupply('O','I',details({qty:2,operationId:'MANUAL-2'}));
 assert.equal(f.docs.get('orders/O').items[0].supplyOrderedQty,5);
 assert.equal(f.docs.get('procurementDemands/D').orderedQty,5);
 assert.equal(f.docs.get('supplyOrders/MANUAL-1').warehouseId,'');
 assert.equal(f.docs.get('supplyOrders/MANUAL-2').receivedQty,0);
});
test('account or role changes during supplier reads stop every source/demand/supply write',async()=>{
 for(const change of [c=>{c.currentUser={uid:'OTHER'};},c=>{c.currentUserRole='engineer';}]){
  const f=fixture(),run=f.c.runRoleTransaction;
  f.c.runRoleTransaction=callback=>run(tx=>callback({...tx,get:async ref=>{const snapshot=await tx.get(ref);if(ref.path.startsWith('supplyOrders/'))change(f.c);return snapshot;}}));
  await assert.rejects(f.c.commitSelfOrderSupply('O','I',details()),/登入身份已變更/);
  assert.equal(f.writes(),0);assert.equal(f.docs.has('supplyOrders/MANUAL-1'),false);
 }
});
test('missing supplier-validation core is a hard stop, not a fallback to unvalidated commitments',async()=>{
 const f=fixture();f.c.YushinSupply=undefined;
 await assert.rejects(f.c.commitSelfOrderSupply('O','I',details()),/供應核心未載入/);assert.equal(f.writes(),0);
});
