'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const core=require('../modules/procurement-demand-core');
const {previewV2FormalPurchase,strictRequest}=require('../functions/formal-purchase-preview-service');
const {commitV2FormalPurchase,purchaseIntent}=require('../functions/formal-purchase-commit-service');

function fixture(){
 const orderId='ORDER-1',itemId='S',productId='P',warehouseId='W';
 const item={itemId,productId,warehouseId,fulfillmentType:'WAREHOUSE',
  qty:12,reservedQty:5,shortageQty:7,supplyOrderedQty:0,receivedQty:0};
 const order={ownerUid:'seller',salesCode:'B',status:'active',
  orderStatus:'normal',inventoryReservationStatus:'completed',items:[item]};
 const demandId=core.demandIdForSource({sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId});
 const demand=core.demandDocument(core.fromSalesOrder({
  demandId,sourceType:'SALES_ORDER',sourceId:orderId,sourceItemId:itemId,
  sourceItemIndex:0,ownerUid:'seller',salesCode:'B',
  productKey:productId,productId,warehouseId,
  shortageQty:7,supplyOrderedQty:0,receivedQty:0
 }),{createdAt:'2026-10-20T00:00:00Z'});
 const records=new Map([
  ['users/buyer',{role:'purchaser',active:true}],
  ['users/admin',{role:'admin',active:true}],
  ['users/seller',{role:'sales',active:true}],
  ['users/off',{role:'purchaser',active:false}],
  ['orders/'+orderId,order],
  ['products/'+productId,{productType:'Goods',active:true}],
  ['warehouses/'+warehouseId,{active:true}],
  ['procurementDemands/'+encodeURIComponent(demandId),demand]
 ]);
 let writes=0;
 const db={
  collection(name){return {doc(id){return {path:name+'/'+id};}};},
  async runTransaction(fn){
   const tx={
    async get(ref){return {
     exists:records.has(ref.path),
     data:()=>records.get(ref.path)
    };},
    set(){writes++;throw Error('Read-only PO guard performed a write');},
    update(){writes++;throw Error('Read-only PO guard performed a write');},
    delete(){writes++;throw Error('Read-only PO guard performed a write');}
   };
   return fn(tx);
  }
 };
 const input={poNo:'PO-20261020-1',orderId,itemId,qty:4};
 return {db,input,records,order,demand,demandId,writes:()=>writes};
}

test('server PO admission shares demand projection, returns no cost and never writes',async()=>{
 const {db,input,demandId,writes}=fixture();
 const result=await previewV2FormalPurchase(db,'buyer',input);
 assert.deepEqual(result,{
  poNo:input.poNo,orderId:input.orderId,itemId:input.itemId,
  productId:'P',warehouseId:'W',demandId,
  requestedQty:7,orderedQty:0,remainingToOrderQty:7,
  proposedQty:4,remainingAfterQty:3,status:'preview-only'
 });
 assert.equal(writes(),0);
 const admin=await previewV2FormalPurchase(db,'admin',{...input,qty:7});
 assert.equal(admin.remainingAfterQty,0);
 assert.equal(writes(),0);
});
test('server PO admission never trusts client role, arbitrary writes or user status',async()=>{
 const {db,input,records,writes}=fixture();
 for(const uid of ['seller','off','missing']){
  await assert.rejects(previewV2FormalPurchase(db,uid,input),{code:'permission-denied'});
 }
 for(const bad of [{...input,actorRole:'admin'}, {...input,qty:0},
  {...input,qty:1.5},{...input,qty:8},{...input,qty:'4'}, {...input,poNo:'../bad'}]){
  await assert.rejects(previewV2FormalPurchase(db,'buyer',bad),{code:bad.qty===8?'failed-precondition':'invalid-argument'});
 }
 records.set('users/buyer',{role:'purchaser',disabled:true});
 await assert.rejects(previewV2FormalPurchase(db,'buyer',input),{code:'permission-denied'});
 assert.equal(writes(),0);
});
test('server PO admission refuses stale source, bad warehouses, replaced demand and reused PO ID',async()=>{
 const {db,input,records,order,demand,demandId,writes}=fixture();
 const need='procurementDemands/'+encodeURIComponent(demandId);
 records.set('orders/'+input.orderId,{...order,orderStatus:'cancelled'});
 await assert.rejects(previewV2FormalPurchase(db,'buyer',input),{code:'failed-precondition'});
 records.set('orders/'+input.orderId,order);
 records.set('warehouses/W',{active:false});
 await assert.rejects(previewV2FormalPurchase(db,'buyer',input),{code:'failed-precondition'});
 records.set('warehouses/W',{active:true});
 records.set(need,{...demand,orderedQty:1,remainingToOrderQty:6,status:'PARTIALLY_ORDERED'});
 await assert.rejects(previewV2FormalPurchase(db,'buyer',input),{code:'failed-precondition'});
 records.set(need,demand);
 records.set('purchaseOrders/'+input.poNo,{poNo:input.poNo});
 await assert.rejects(previewV2FormalPurchase(db,'buyer',input),{code:'already-exists'});
 assert.equal(writes(),0);
});
test('strict PO request allows only a bounded four-field identity',()=>{
 const input={poNo:'PO-1',orderId:'O-1',itemId:'S',qty:4};
 assert.deepEqual(strictRequest(input),input);
 for(const row of [{...input,qty:NaN},{...input,qty:-1},{...input,qty:1000001},
  {...input,orderId:'O/1'},{...input,extra:{}},[input],null]){
  assert.throws(()=>strictRequest(row),error=>error.code==='invalid-argument');
 }
});

function writeFixture(){
 const fixtureState=fixture(),{records}=fixtureState,history=[];
 const database={
  collection(collection){return {doc(id){return {path:collection+'/'+id};}};},
  async runTransaction(fn){
   const commands=[];
   const tx={
    async get(ref){assert.equal(commands.length,0,'all reads precede writes');return {exists:records.has(ref.path),data:()=>records.get(ref.path)};},
    create(ref,document){commands.push({op:'create',path:ref.path,document});},
    set(ref,document){commands.push({op:'set',path:ref.path,document});},
    update(ref,patch){commands.push({op:'update',path:ref.path,patch});}
   };
   const result=await fn(tx);
   // Test transaction applies all writes only after the callback succeeds.
   for(const c of commands){
    if(c.op==='create'&&records.has(c.path))throw Error('conflict');
    if(c.op==='update'&&!records.has(c.path))throw Error('missing update');
   }
   for(const c of commands){
    if(c.op==='update')records.set(c.path,{...records.get(c.path),...c.patch});
    else records.set(c.path,c.document);
    history.push(c);
   }
   return result;
  }
 };
 const data={...fixtureState.input,unitCost:19.99,supplier:'權威供應商',poDate:'2026-10-20'};
 return {...fixtureState,db:database,data,history};
}
test('server PO transaction commits one atomic supplier obligation and is idempotent',async()=>{
 const {db,data,records,history,demandId}=writeFixture();
 const result=await commitV2FormalPurchase(db,'buyer',data);
 assert.equal(result.status,'committed');
 assert.equal(result.committedQty,4);
 assert.deepEqual(result.supplyOrderIds,['po-'+encodeURIComponent(data.poNo)+'-0']);
 assert.equal(history.length,4);
 const po=records.get('purchaseOrders/'+data.poNo);
 const supply=records.get('supplyOrders/'+result.supplyOrderIds[0]);
 const demand=records.get('procurementDemands/'+encodeURIComponent(demandId));
 const source=records.get('orders/'+data.orderId);
 assert.equal(po.serverCommitHash.length,64);
 assert.equal(po.createdByUid,'buyer');
 assert.equal(po.items[0].qty,4);
 assert.equal(supply.qty,4);
 assert.equal(supply.unitCost,19.99);
 assert.equal(supply.incomingRegisteredQty,0);
 assert.equal(supply.receivedQty,0);
 assert.equal(demand.requestedQty,7);
 assert.equal(demand.orderedQty,4);
 assert.equal(demand.remainingToOrderQty,3);
 assert.equal(demand.remainingToReceiveQty,4);
 assert.equal(source.items[0].supplyOrderedQty,4);
 assert.equal(source.items[0].reservedQty,5);
 assert.equal(source.items[0].shortageQty,7);
 const repeat=await commitV2FormalPurchase(db,'buyer',data);
 assert.equal(repeat.status,'already-applied');
 assert.equal(history.length,4);
 assert.equal(records.get('orders/'+data.orderId),source);
 await assert.rejects(commitV2FormalPurchase(db,'buyer',{...data,qty:3}),{code:'already-exists'});
 await assert.rejects(commitV2FormalPurchase(db,'admin',data),{code:'already-exists'});
 assert.equal(history.length,4);
});
test('server PO transaction rejects unauthorized, overordered or stale demand with zero writes',async()=>{
 const {db,data,records,history,demandId}=writeFixture();
 for(const who of ['seller','off','missing']){
  await assert.rejects(commitV2FormalPurchase(db,who,data),{code:'permission-denied'});
 }
 await assert.rejects(commitV2FormalPurchase(db,'buyer',{...data,qty:8}),{code:'failed-precondition'});
 await assert.rejects(commitV2FormalPurchase(db,'buyer',{...data,poNo:'PO-stale',supplier:'bad\u0000vendor'}),{code:'invalid-argument'});
 const saved=records.get('procurementDemands/'+encodeURIComponent(demandId));
 records.set('procurementDemands/'+encodeURIComponent(demandId),{...saved,orderedQty:3});
 await assert.rejects(commitV2FormalPurchase(db,'buyer',data),{code:'failed-precondition'});
 assert.equal(history.length,0);
 assert.equal(records.has('purchaseOrders/'+data.poNo),false);
 assert.equal(records.has('supplyOrders/po-'+encodeURIComponent(data.poNo)+'-0'),false);
});
test('server PO intent validates exact input shape, money precision and date',()=>{
 const {data}=writeFixture();
 assert.equal(purchaseIntent(data).unitCost,19.99);
 for(const invalid of [
  {...data,unitCost:-1},{...data,unitCost:Infinity},
  {...data,unitCost:9.999},{...data,poDate:'2026-02-30'},
  {...data,poDate:'yesterday'},{...data,createdByRole:'admin'}
 ])assert.throws(()=>purchaseIntent(invalid),e=>e.code==='invalid-argument');
});

function addPurchaseSource(x,orderId,itemId,{productId='P',warehouseId='W',shortageQty=7}={}){
 const source=x.records.get('orders/'+orderId)||{
  ownerUid:'seller',salesCode:'B',status:'active',orderStatus:'normal',
  inventoryReservationStatus:'completed',workCategories:['dispatch','ordering'],items:[]
 };
 const item={itemId,productId,warehouseId,fulfillmentType:'WAREHOUSE',
  qty:12,reservedQty:12-shortageQty,shortageQty,supplyOrderedQty:0,receivedQty:0};
 const index=source.items.length;source.items.push(item);x.records.set('orders/'+orderId,source);
 x.records.set('products/'+productId,{productType:'Goods',active:true});
 x.records.set('warehouses/'+warehouseId,{active:true});
 const demand=core.demandDocument(core.fromSalesOrder({...item,sourceType:'SALES_ORDER',
  sourceId:orderId,sourceItemId:itemId,sourceItemIndex:index,ownerUid:'seller',salesCode:'B',productKey:productId}));
 x.records.set('procurementDemands/'+encodeURIComponent(demand.demandId),demand);
 return {orderId,itemId,qty:shortageQty,unitCost:10.25};
}
function mergedIntent(x,items){return {poNo:x.data.poNo,poDate:x.data.poDate,supplier:x.data.supplier,items};}

test('five-line server PO merges same-order updates and crossed orders without overwriting siblings',async()=>{
 const x=writeFixture();
 const items=[{orderId:x.data.orderId,itemId:x.data.itemId,qty:4,unitCost:19.99},
  addPurchaseSource(x,'ORDER-1','S2',{warehouseId:'W2'}),
  addPurchaseSource(x,'ORDER-2','A',{productId:'P2'}),
  addPurchaseSource(x,'ORDER-2','B',{warehouseId:'W2'}),
  addPurchaseSource(x,'ORDER-3','C')];
 const input=mergedIntent(x,items),before=structuredClone([...x.records]);
 const result=await commitV2FormalPurchase(x.db,'buyer',input);
 assert.equal(result.status,'committed');assert.equal(result.committedQty,32);
 assert.equal(result.supplyOrderIds.length,5);assert.equal(result.demandIds.length,5);
 assert.equal(x.history.length,14,'one PO, five supplies, five demands, three source updates');
 const source=x.records.get('orders/ORDER-1');
 assert.deepEqual(source.items.map(item=>item.supplyOrderedQty),[4,7]);
 assert.equal(source.items[0].shortageQty,7);assert.equal(source.items[0].reservedQty,5);
 assert.ok(source.workCategories.includes('ordering'),'partially ordered first line stays pending');
 assert.ok(x.records.get('orders/ORDER-2').workCategories.includes('dispatch'));
 assert.equal(x.records.get('orders/ORDER-2').workCategories.includes('ordering'),false);
 const po=x.records.get('purchaseOrders/'+input.poNo);
 assert.deepEqual(po.orderIds,['ORDER-1','ORDER-2','ORDER-3']);
 assert.deepEqual(po.items.map(line=>line.warehouseId),['W','W2','W','W2','W']);
 for(const [index,line] of items.entries()){
  const supply=x.records.get('supplyOrders/'+result.supplyOrderIds[index]);
  assert.equal(supply.sourceId,line.orderId);assert.equal(supply.sourceItemId,line.itemId);
  assert.equal(supply.qty,line.qty);assert.equal(supply.unitCost,line.unitCost);
  assert.equal(supply.receivedQty,0);assert.equal(supply.incomingRegisteredQty,0);
 }
 assert.equal(x.history.some(command=>/inventory|warehouseStocks/.test(command.path)),false);
 const committed=structuredClone([...x.records]);
 assert.equal((await commitV2FormalPurchase(x.db,'buyer',input)).status,'already-applied');
 assert.deepEqual([...x.records],committed);assert.equal(x.history.length,14);
 await assert.rejects(commitV2FormalPurchase(x.db,'buyer',{...input,items:[...items].reverse()}),{code:'already-exists'});
 assert.notDeepEqual([...x.records],before);
});

test('fully purchasing one line preserves unselected sibling shortage and existing dispatch queue',async()=>{
 const x=writeFixture();addPurchaseSource(x,'ORDER-1','S2');
 x.records.get('orders/ORDER-1').workCategories=['dispatch','ordering'];
 await commitV2FormalPurchase(x.db,'buyer',{...x.data,qty:7});
 const order=x.records.get('orders/ORDER-1');
 assert.deepEqual(order.items.map(item=>item.supplyOrderedQty),[7,0]);
 assert.ok(order.workCategories.includes('ordering'));
 assert.ok(order.workCategories.includes('dispatch'));
});

test('invalid final line or occupied final supply ID rejects entire merged PO with zero writes',async()=>{
 for(const failure of ['excess','stale','warehouse','service','supply']){
  const x=writeFixture(),second=addPurchaseSource(x,'ORDER-2','S2');
  const items=[{orderId:x.data.orderId,itemId:x.data.itemId,qty:4,unitCost:19.99},second];
  if(failure==='excess')second.qty=8;
  if(failure==='stale'){
   const id=core.demandIdForSource({sourceType:'SALES_ORDER',sourceId:'ORDER-2',sourceItemId:'S2'});
   x.records.get('procurementDemands/'+encodeURIComponent(id)).receivedQty=1;
  }
  if(failure==='warehouse')x.records.get('orders/ORDER-2').items[0].warehouseId='MISSING';
  if(failure==='service')x.records.get('orders/ORDER-2').items[0].productType='SERVICE';
  if(failure==='supply')x.records.set('supplyOrders/po-'+encodeURIComponent(x.data.poNo)+'-1',{other:true});
  const before=structuredClone([...x.records]);
  await assert.rejects(commitV2FormalPurchase(x.db,'buyer',mergedIntent(x,items)),{code:failure==='supply'?'already-exists':'failed-precondition'});
  assert.equal(x.history.length,0);assert.deepEqual([...x.records],before);
 }
});

test('merged purchase request is bounded, rejects duplicate source rows and canonicalizes one-row replay',async()=>{
 const x=writeFixture(),line={orderId:x.data.orderId,itemId:x.data.itemId,qty:4,unitCost:19.99};
 assert.deepEqual(purchaseIntent(mergedIntent(x,[line])),purchaseIntent(x.data));
 for(const bad of [[],[line,line],Array.from({length:6},(_,index)=>({...line,itemId:'I'+index})),
  [{...line,qty:0}],[{...line,actorRole:'admin'}],[{...line,unitCost:NaN}]]){
  assert.throws(()=>purchaseIntent(mergedIntent(x,bad)),e=>e.code==='invalid-argument');
 }
 await commitV2FormalPurchase(x.db,'buyer',x.data);
 assert.equal((await commitV2FormalPurchase(x.db,'buyer',mergedIntent(x,[line]))).status,'already-applied');
});

test('merged purchase replay rejects missing or relinked supply without changing any document',async()=>{
 for(const damage of ['missing','source','qty','po-line']){
  const x=writeFixture(),items=[{orderId:x.data.orderId,itemId:x.data.itemId,qty:4,unitCost:19.99},addPurchaseSource(x,'ORDER-2','S2')];
  const input=mergedIntent(x,items),result=await commitV2FormalPurchase(x.db,'buyer',input);
  const key='supplyOrders/'+result.supplyOrderIds[1];
  if(damage==='missing')x.records.delete(key);
  if(damage==='source')x.records.get(key).sourceId='OTHER';
  if(damage==='qty')x.records.get(key).qty=1;
  if(damage==='po-line')x.records.get('purchaseOrders/'+input.poNo).items[1].qty=1;
  const before=structuredClone([...x.records]),count=x.history.length;
  await assert.rejects(commitV2FormalPurchase(x.db,'buyer',input),{code:'failed-precondition'});
  assert.deepEqual([...x.records],before);assert.equal(x.history.length,count);
 }
});

function documentIntent(){return {company:'yushin',
 supplierSnapshot:{supplierId:'SUP-1',supplierName:'權威供應商',purchaseHeaderName:'供應商採購抬頭',email:'orders@example.test',leadTimeDays:7},
 expectedDate:'2026-10-27',expectedDateSource:'manual',lineScheduleDates:['2026-10-27']};}
test('server PO preserves original document header, price projection, supplier and bidirectional source links',async()=>{
 const x=writeFixture(),data={...x.data,document:documentIntent()};
 x.records.get('orders/'+data.orderId).linkedDocuments=[{type:'quote',id:'Q1',relation:'source'}];
 const result=await commitV2FormalPurchase(x.db,'buyer',data);
 const po=x.records.get('purchaseOrders/'+data.poNo),supply=x.records.get('supplyOrders/'+result.supplyOrderIds[0]);
 assert.equal(po.company,'yushin');assert.equal(po.vendorName,'供應商採購抬頭');
 assert.deepEqual(po.supplierSnapshot,data.document.supplierSnapshot);
 assert.deepEqual([po.subtotalExTax,po.taxAmount,po.totalIncTax],[80,4,84]);
 assert.equal(po.expectedDate,'2026-10-27');assert.equal(po.items[0].scheduleDate,'2026-10-27');
 assert.equal(supply.expectedDate,'2026-10-27');assert.equal(supply.supplierId,'SUP-1');assert.equal(supply.supplierEmail,'orders@example.test');
 assert.deepEqual(po.linkedDocuments,[{type:'order',id:data.orderId,relation:'source'}]);
 assert.deepEqual(x.records.get('orders/'+data.orderId).linkedDocuments,[{type:'quote',id:'Q1',relation:'source'},{type:'purchaseOrder',id:data.poNo,relation:'document'}]);
 assert.ok(po.searchTokens.includes('供應商'));assert.ok(po.searchTokens.length<=300);
 const before=structuredClone([...x.records]);
 assert.equal((await commitV2FormalPurchase(x.db,'buyer',data)).status,'already-applied');
 assert.deepEqual([...x.records],before);
 await assert.rejects(commitV2FormalPurchase(x.db,'buyer',{...data,document:{...data.document,company:'morningstar'}}),{code:'already-exists'});
});
test('server document input cannot inject totals, actor, stock fields, invalid dates or arbitrary companies',async()=>{
 const cases=[d=>({...d,subtotalExTax:1}),d=>({...d,actorRole:'admin'}),d=>({...d,company:'foreign'}),
  d=>({...d,expectedDate:'2026-02-30'}),d=>({...d,lineScheduleDates:[]}),
  d=>({...d,supplierSnapshot:{...d.supplierSnapshot,email:'invalid'}}),
  d=>({...d,supplierSnapshot:{...d.supplierSnapshot,leadTimeDays:-1}}),
  d=>({...d,supplierSnapshot:{...d.supplierSnapshot,supplierName:'改名'}}),
  d=>({...d,supplierSnapshot:{...d.supplierSnapshot,incoming:999}})];
 for(const mutate of cases){const x=writeFixture();
  await assert.rejects(commitV2FormalPurchase(x.db,'buyer',{...x.data,document:mutate(documentIntent())}),{code:'invalid-argument'});
  assert.equal(x.history.length,0);
 }
});
test('document replay rejects corrupted saved metadata and supplier dates while preserving receipt progress',async()=>{
 for(const damage of ['header','supplier','date']){
  const x=writeFixture(),input={...x.data,document:documentIntent()};
  const result=await commitV2FormalPurchase(x.db,'buyer',input);
  const supply=x.records.get('supplyOrders/'+result.supplyOrderIds[0]);
  supply.receivedQty=1;supply.incomingRegisteredQty=3;
  assert.equal((await commitV2FormalPurchase(x.db,'buyer',input)).status,'already-applied');
  if(damage==='header')x.records.get('purchaseOrders/'+input.poNo).totalIncTax=1;
  if(damage==='supplier')supply.supplierEmail='other@example.test';
  if(damage==='date')supply.expectedDate='2026-11-01';
  const before=structuredClone([...x.records]);
  await assert.rejects(commitV2FormalPurchase(x.db,'buyer',input),{code:'failed-precondition'});
  assert.deepEqual([...x.records],before);
 }
});

function savedDocumentFixture(x){
 const data={...x.data,document:documentIntent()};
 const draft={poNo:data.poNo,poDate:data.poDate,supplierName:data.supplier,vendorName:data.document.supplierSnapshot.purchaseHeaderName,
  company:data.document.company,supplierSnapshot:data.document.supplierSnapshot,
  expectedDate:data.document.expectedDate,expectedDateSource:data.document.expectedDateSource,
  status:'DRAFT',documentOnly:true,createdByUid:'buyer',createdByRole:'purchaser',
  items:[{orderId:data.orderId,itemId:data.itemId,productId:'P',warehouseId:'W',qty:data.qty,unitPrice:data.unitCost,scheduleDate:data.document.lineScheduleDates[0]}]};
 x.records.set('purchaseOrders/'+data.poNo,draft);return {data,draft};
}
test('server confirmation upgrades draft document through same validated atomic writer and replays read-only',async()=>{
 const x=writeFixture(),{data}=savedDocumentFixture(x),before=structuredClone(x.records.get('orders/ORDER-1'));
 assert.equal(x.history.length,0);assert.equal(before.items[0].supplyOrderedQty,0);
 const result=await commitV2FormalPurchase(x.db,'buyer',data),po=x.records.get('purchaseOrders/'+data.poNo);
 assert.equal(result.status,'committed');assert.equal(po.status,'ORDERED');assert.equal(po.documentOnly,false);
 assert.equal(x.records.get('orders/ORDER-1').items[0].supplyOrderedQty,data.qty);
 const written=x.history.length,after=structuredClone([...x.records]);
 assert.equal((await commitV2FormalPurchase(x.db,'buyer',data)).status,'already-applied');
 assert.equal(x.history.length,written);assert.deepEqual([...x.records],after);
});
test('draft confirmation revalidates current role, source demand and immutable intent before any write',async()=>{
 for(const change of ['qty','supplier','company','date','product','warehouse','disabled','cancelled','filled','occupied-supply']){
  const x=writeFixture(),{data,draft}=savedDocumentFixture(x);
  if(change==='qty')data.qty=3;
  if(change==='supplier')draft.supplierName='Changed';
  if(change==='company')data.document.company='morningstar';
  if(change==='date')draft.poDate='2026-10-19';
  if(change==='product')draft.items[0].productId='OTHER';
  if(change==='warehouse')draft.items[0].warehouseId='OTHER';
  if(change==='disabled')x.records.get('users/buyer').active=false;
  if(change==='cancelled')x.records.get('orders/ORDER-1').status='cancelled';
  if(change==='filled')x.records.get('orders/ORDER-1').items[0].supplyOrderedQty=7;
  if(change==='occupied-supply')x.records.set('supplyOrders/po-'+encodeURIComponent(data.poNo)+'-0',{other:true});
  const before=structuredClone([...x.records]);
  await assert.rejects(commitV2FormalPurchase(x.db,'buyer',data));
  assert.equal(x.history.length,0);assert.deepEqual([...x.records],before);
 }
});

test('server confirmation rejects stale document revision even when quantities are unchanged',async()=>{
 const x=writeFixture(),{data,draft}=savedDocumentFixture(x);
 draft.documentRevision=2;data.documentRevision=1;
 const before=structuredClone([...x.records]);
 await assert.rejects(commitV2FormalPurchase(x.db,'buyer',data),{code:'failed-precondition'});
 assert.deepEqual([...x.records],before);assert.equal(x.history.length,0);
 data.documentRevision=2;
 assert.equal((await commitV2FormalPurchase(x.db,'buyer',data)).status,'committed');
});


// Direct shipment commits a supplier obligation and customer demand, never stock.
function directSourceFixture(){
 const x=writeFixture(),order=x.records.get('orders/ORDER-1'),item=order.items[0];
 Object.assign(item,{qty:7,fulfillmentType:'DIRECT_SHIP',warehouseId:'',
  reservedQty:0,shortageQty:0,receivedQty:0,supplyOrderedQty:0});
 const demand=x.records.get('procurementDemands/'+encodeURIComponent(x.demandId));
 Object.assign(demand,{fulfillmentType:'DIRECT_SHIP',warehouseId:'',
  requestedQty:7,orderedQty:0,receivedQty:0,remainingToOrderQty:7,remainingToReceiveQty:0,status:'PENDING'});
 return x;
}
test('direct shipment server purchase is atomic and never changes warehouse inventory',async()=>{
 const x=directSourceFixture(),result=await commitV2FormalPurchase(x.db,'buyer',x.data);
 assert.equal(result.status,'committed');
 const supply=x.records.get('supplyOrders/'+result.supplyOrderIds[0]),po=x.records.get('purchaseOrders/'+x.data.poNo);
 assert.equal(supply.fulfillmentType,'DIRECT_SHIP');assert.equal(supply.warehouseId,'');
 assert.equal(supply.incomingRegisteredQty,0);assert.equal(supply.receivedQty,0);
 assert.equal(po.items[0].fulfillmentType,'DIRECT_SHIP');assert.equal(po.items[0].warehouseId,'');
 assert.equal(x.records.get('procurementDemands/'+encodeURIComponent(x.demandId)).remainingToOrderQty,3);
 assert.equal(x.records.get('orders/ORDER-1').items[0].supplyOrderedQty,4);
 assert.equal(x.history.length,4);assert.equal(x.history.some(c=>/inventory|warehouseStocks|inventoryLots|Movements/.test(c.path)),false);
 const committed=structuredClone([...x.records]);
 assert.equal((await commitV2FormalPurchase(x.db,'buyer',x.data)).status,'already-applied');
 assert.deepEqual([...x.records],committed);assert.equal(x.history.length,4);
});
test('direct shipment server refuses tampered demand, service or source warehouse without writes',async()=>{
 for(const problem of ['type','warehouse','over','service','reserved','changed-order','actor']){
  const x=directSourceFixture(),order=x.records.get('orders/ORDER-1'),
   demand=x.records.get('procurementDemands/'+encodeURIComponent(x.demandId));
  if(problem==='type')demand.fulfillmentType='WAREHOUSE';
  if(problem==='warehouse')order.items[0].warehouseId='W';
  if(problem==='over')x.data.qty=8;
  if(problem==='service')order.items[0].productType='SERVICE';
  if(problem==='reserved')order.items[0].reservedQty=1;
  if(problem==='changed-order')demand.requestedQty=99;
  const before=structuredClone([...x.records]);
  await assert.rejects(commitV2FormalPurchase(x.db,problem==='actor'?'seller':'buyer',x.data));
  assert.equal(x.history.length,0);assert.deepEqual([...x.records],before);
 }
});
test('direct shipment document upgrade checks original fulfillment mode before writes',async()=>{
 const x=directSourceFixture(),one=savedDocumentFixture(x);
 one.draft.items[0].warehouseId='';one.draft.items[0].fulfillmentType='DIRECT_SHIP';
 assert.equal((await commitV2FormalPurchase(x.db,'buyer',one.data)).status,'committed');
 const y=directSourceFixture(),two=savedDocumentFixture(y);
 two.draft.items[0].warehouseId='W';two.draft.items[0].fulfillmentType='WAREHOUSE';
 await assert.rejects(commitV2FormalPurchase(y.db,'buyer',two.data),{code:'failed-precondition'});
 assert.equal(y.history.length,0);
});
