const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const service=fs.readFileSync('src/services/order-creation.js','utf8');
const forecastFeature=fs.readFileSync('src/features/forecasts/forecast-workspace.js','utf8');
const plain=x=>JSON.parse(JSON.stringify(x));
function fixture(){
 const docs=new Map(),writes=[],reads=[],stored=new Map();
 const state={lost:false,replay:false,rejectCommit:false,afterRead:null,afterCommit:null};
 const c=vm.createContext({currentUser:{uid:'U'},currentUserRole:'sales',BUSINESS_STATUS:{ACTIVE:'active'},YushinOrderEntry:require('../modules/order-entry-core'),
  DOCUMENT_TYPES:{FORECAST:'forecast',ORDER:'order'},normalizedOrderStatus:o=>[o.status,o.orderStatus].some(s=>['cancelled','voided'].includes(s))?'cancelled':'normal',
  documentLink:(type,id,relation)=>({type,id,relation}),firebase:{firestore:{FieldValue:{arrayUnion:value=>({union:value})}}},
  db:{collection:name=>({doc:id=>({id:id||'O',path:name+'/'+(id||'O')})})},
  runRoleTransaction:async callback=>{
   let staged=[];
   const tx={get:async ref=>{reads.push(ref.path);const data=docs.get(ref.path);if(state.afterRead)state.afterRead(ref);return {exists:!!data,data:()=>plain(data)};},
    set:(ref,data)=>staged.push(['set',ref.path,plain(data)]),update:(ref,data)=>staged.push(['update',ref.path,plain(data)])};
   if(state.replay){await callback(tx);staged=[];}
   await callback(tx);
   if(state.rejectCommit)throw Error('commit rejected');
   for(const [op,key,data] of staged){
    const next=op==='set'?data:{...docs.get(key),...data};
    if(data.linkedDocuments?.union)next.linkedDocuments=[...(docs.get(key)?.linkedDocuments||[]),data.linkedDocuments.union];
    docs.set(key,next);writes.push([op,key]);
   }
   if(state.afterCommit)state.afterCommit();
   if(state.lost){state.lost=false;throw Error('lost reply');}
  }});
 vm.runInContext(service,c);
 const data={transactionType:'借',createdByUid:'U',status:'active',ownerUid:'U',createdAt:'T',inventoryReservationStatus:'pending'};
 const forecast={...data,sourceType:'forecast',sourceId:'F',sourceDocumentSyncStatus:'completed'};
 docs.set('forecasts/F',{ownerUid:'U',status:'active',updatedAt:'V',linkedDocuments:[]});
 return {c,docs,writes,reads,state,stored,data,forecast,run:(d=forecast,options={})=>c.commitOrderCreation('O',d,{linkForecast:true,expectedForecastUpdatedAt:'V',...options})};
}
test('creation service owns the commit without browser storage DOM or cache collaborators',()=>{
 assert.doesNotMatch(service,/\b(window|document|localStorage|sessionStorage|ordersCache)\b\s*[.=[(]/);
 const feature=fs.readFileSync('src/features/orders/order-creation.js','utf8');
 const wrapper=feature.slice(feature.indexOf('async function createOrResumeNewOrder'),feature.indexOf('function orderDraftFieldValue'));
 assert.match(wrapper,/commitOrderCreation/);assert.doesNotMatch(wrapper,/runRoleTransaction|\.set\(/);
 const direct=forecastFeature.slice(forecastFeature.indexOf('async function createForecastOrdersDirectly'),forecastFeature.indexOf('window.createOrderFromForecast'));
 assert.match(direct,/commitOrderCreation/);assert.doesNotMatch(direct,/db\.batch\(|runRoleTransaction/);
});
test('manual creation resumes authoritative order without overwriting changed form or inventory',async()=>{
 const f=fixture();await f.c.commitOrderCreation('O',f.data);f.docs.get('orders/O').inventoryReservationStatus='completed';
 const result=await f.c.commitOrderCreation('O',{...f.data,customerName:'changed'});
 assert.equal(result.data.inventoryReservationStatus,'completed');assert.equal(result.data.customerName,undefined);assert.equal(f.writes.length,1);
});
test('Forecast order and backlink commit once after callback replay and lost reply',async()=>{
 const f=fixture();f.state.replay=true;f.state.lost=true;
 await assert.rejects(f.run(),/lost reply/);assert.equal(f.writes.length,2);
 f.docs.delete('forecasts/F');f.reads.length=0;f.state.replay=false;
 const saved=await f.run();assert.equal(saved.id,'O');assert.deepEqual(f.reads,['orders/O']);assert.equal(f.writes.length,2);
});
test('failed Forecast commit leaves neither order nor backlink',async()=>{
 const f=fixture();f.state.rejectCommit=true;await assert.rejects(f.run(),/commit rejected/);
 assert.equal(f.docs.has('orders/O'),false);assert.equal(f.docs.get('forecasts/F').linkedDocuments.length,0);assert.equal(f.writes.length,0);
});
test('creation captures input before awaiting reads',async()=>{
 const f=fixture();f.state.afterRead=()=>{f.forecast.ownerUid='intruder';};await f.run();
 assert.equal(f.docs.get('orders/O').ownerUid,'U');assert.equal(f.docs.get('forecasts/F').linkedDocuments[0].id,'O');
});
for(const [label,change,pattern] of [
 ['missing',f=>f.docs.delete('forecasts/F'),/不存在/],
 ['cancelled',f=>f.docs.get('forecasts/F').status='cancelled',/取消/],
 ['stale',f=>f.docs.get('forecasts/F').updatedAt='NEW',/已變更/],
 ['foreign owner',f=>f.docs.get('forecasts/F').ownerUid='OTHER',/負責人/],
 ['wrong creator',f=>f.forecast.createdByUid='OTHER',/身分/],
 ['wrong source kind',f=>f.forecast.sourceType='quote',/來源/],
 ['unauthorized role',f=>f.c.currentUserRole='engineer',/權限/],
 ['UID switch on read',f=>f.state.afterRead=()=>{f.c.currentUser={uid:'OTHER'};},/身分/],
 ['role switch on read',f=>f.state.afterRead=()=>{f.c.currentUserRole='admin';},/身分/]
])test('creation rejects '+label+' without partial writes',async()=>{const f=fixture();change(f);await assert.rejects(f.run(),pattern);assert.equal(f.writes.length,0);assert.equal(f.docs.has('orders/O'),false);});
test('pending ID cannot resume a foreign cancelled or different-source order',async()=>{
 for(const patch of [{createdByUid:'OTHER'},{status:'cancelled'},{orderStatus:'voided'},{sourceId:'OTHER'}]){
  const f=fixture();f.docs.set('orders/O',{...f.forecast,...patch});await assert.rejects(f.run());assert.equal(f.writes.length,0);
 }
});
test('postcommit actor switch reports committed identity without pretending rollback',async()=>{
 const f=fixture();f.state.afterCommit=()=>{f.c.currentUserRole='admin';};
 await assert.rejects(f.run(),e=>e.orderCommitted===true&&e.orderId==='O');assert.equal(f.writes.length,2);
});
function forecastFixture(){
 const f=fixture(),c=f.c;
 Object.assign(c,{ORDER_DRAFT_STORAGE_PREFIX:'draft',localStorage:{getItem:k=>f.stored.get(k)||null,setItem:(k,v)=>f.stored.set(k,v),removeItem:k=>f.stored.delete(k)},
  localDateString:()=> 'TODAY',forecastItemToOrderSource:(forecast,item)=>item,normalizeNewOrderItem:item=>item,assertOrderItemCount(){},
  commercialCreatorFields:()=>({createdByUid:'U'}),customerIdForName:()=>'',brandIdForName:()=>'',normalizeHistoryItemCode:x=>x,
  productIdsFromItems:items=>items.map(i=>i.productId),grossAmountMetadata:()=>({}),linkedDocumentFields:(sourceType,sourceId)=>({sourceType,sourceId}),
  currentUserName:'Name',currentUserCode:'S',buildFullHistorySearchTokens:()=>[],ordersCache:[],
  synchronizeOrderInventory:async(id,data)=>{data.inventoryReservationStatus='completed';}});
 vm.runInContext(forecastFeature.slice(forecastFeature.indexOf('async function createForecastOrdersDirectly'),forecastFeature.indexOf('window.createOrderFromForecast')),c);
 f.convert=()=>c.createForecastOrdersDirectly({id:'F',ownerUid:'U',updatedAt:'V'},[{itemName:'Item',productId:'P',productMasterMatched:true}],{transactionType:'借'});
 return f;
}
test('Forecast feature preserves pending ID after lost response then clears only after inventory completion',async()=>{
 const f=forecastFixture();f.state.lost=true;await assert.rejects(f.convert(),/lost reply/);
 assert.equal(f.stored.get('draft:U:forecast:F:pending_order_id'),'O');
 const result=await f.convert();assert.equal(result.created[0].id,'O');assert.equal(f.writes.length,2);assert.equal(f.stored.size,0);assert.equal(f.c.ordersCache.length,1);
});
test('Forecast inventory failure retains pending ID and retry uses committed content',async()=>{
 const f=forecastFixture();f.c.synchronizeOrderInventory=async()=>{throw Error('inventory offline');};
 const result=await f.convert();assert.equal(result.reservationFailures.length,1);assert.equal(f.stored.size,1);
 f.c.synchronizeOrderInventory=async()=>{};await f.convert();assert.equal(f.writes.length,2);assert.equal(f.stored.size,0);
});
test('Forecast postcommit session change does not mutate new session cache or clear pending recovery',async()=>{
 const f=forecastFixture();f.state.afterCommit=()=>{f.c.currentUser={uid:'OTHER'};};await assert.rejects(f.convert(),/身分/);
 assert.equal(f.c.ordersCache.length,0);assert.equal(f.stored.size,1);assert.equal(f.writes.length,2);
});

test('return reorder uses ordinary creation and only reads its closed-return source without moving stock or changing the old order',async()=>{
 const f=fixture(),original={ownerUid:'U',customerName:'客戶',returnRecords:[{id:'R',qty:2,settlement:'CLOSE'}],isBilled:true};
 f.docs.set('orders/OLD',original);const data={...f.data,customerName:'客戶',returnReorderSource:{orderId:'OLD'},items:[{productId:'CORRECT',qty:1,unitPrice:250}]};
 const result=await f.c.commitOrderCreation('NEW',data);assert.equal(result.data.items[0].productId,'CORRECT');
 assert.deepEqual(f.writes,[['set','orders/NEW']]);assert.deepEqual(f.docs.get('orders/OLD'),original);
 f.docs.delete('orders/OLD');f.docs.get('orders/NEW').inventoryReservationStatus='completed';
 const replay=await f.c.commitOrderCreation('NEW',data);assert.equal(replay.data.inventoryReservationStatus,'completed');assert.equal(f.writes.length,1);
 await assert.rejects(f.c.commitOrderCreation('NEW',{...data,returnReorderSource:{orderId:'OTHER'}}),/其他退貨來源/);
});
test('return reorder rejects pending, replacement, missing, foreign or different-customer sources without any write',async()=>{
 for(const original of [null,{ownerUid:'U',customerName:'客戶',returnRequests:[{status:'PENDING',qty:2}]},
  {ownerUid:'U',customerName:'客戶',returnRecords:[{qty:2,settlement:'REPLACE'}]},
  {ownerUid:'OTHER',customerName:'客戶',returnRecords:[{qty:2,settlement:'CLOSE'}]},
  {ownerUid:'U',customerName:'其他客戶',returnRecords:[{qty:2,settlement:'CLOSE'}]}]){
  const f=fixture();if(original)f.docs.set('orders/OLD',original);
  await assert.rejects(f.c.commitOrderCreation('NEW',{...f.data,customerName:'客戶',returnReorderSource:{orderId:'OLD'}}));assert.equal(f.writes.length,0);
 }
 const f=fixture();for(const returnReorderSource of [{orderId:'NEW'},{orderId:'A/B'},{orderId:' OLD '},{orderId:'OLD',settlement:'CLOSE'},null])
  await assert.rejects(f.c.commitOrderCreation('NEW',{...f.data,returnReorderSource}));
});
test('return reorder opens a clean order draft with the customer reference and no copied wrong item or price',()=>{
 const feature=fs.readFileSync('src/features/orders/order-creation.js','utf8');
 const fields=new Map();const element=id=>{if(!fields.has(id))fields.set(id,{});return fields.get(id);};let opens=0,saves=0;
 const c=vm.createContext({window:{},ordersCache:[{id:'OLD',orderNo:'NO-1',customerName:'客戶',transactionType:'直',invoiceTitle:'抬頭',
  productId:'WRONG',unitPrice:888,returnRecords:[{qty:1,settlement:'CLOSE'}]}],canManageOrderLifecycleCapability:()=>true,canEditPage:()=>true,
  savedReturnRecords:o=>o.returnRecords,openOrderModal:(...args)=>{assert.deepEqual(args,[]);opens++;},
  document:{getElementById:element},saveOrderDraft:()=>saves++,alert:()=>assert.fail('unexpected alert')});
 vm.runInContext(feature.slice(feature.indexOf('window.reorderAfterReturn'),feature.indexOf('window.copyOrderAsNew')),c);
 c.window.reorderAfterReturn('OLD');assert.equal(opens,1);assert.equal(saves,1);assert.equal(element('orderCustomer').value,'客戶');
 assert.deepEqual(plain(c.window._orderModalReturnReorder),{orderId:'OLD'});assert.match(element('orderRemarks').value,/NO-1/);
 assert.equal(fields.has('orderItemCode'),false);assert.equal(fields.has('orderUnitPrice'),false);
});

test('creation rejects empty and invalid trade types without writes but resumes a legacy committed order',async()=>{
 for(const transactionType of ['',null,123,'其他']){
  const f=fixture();await assert.rejects(f.c.commitOrderCreation('O',{...f.data,transactionType}),/交易方式/);
  assert.equal(f.writes.length,0);
 }
 const f=fixture();f.docs.set('orders/O',{...f.data,transactionType:''});
 const result=await f.c.commitOrderCreation('O',f.data);
 assert.equal(result.data.transactionType,'');assert.equal(f.writes.length,0);
});

test('single and multi-item Forecasts open the required order form without writing and preserve owner/version context',async()=>{
 for(const count of [1,3]){
  const forecast={id:'F',ownerUid:'OWNER',salesName:'Owner',salesCode:'S01',updatedAt:'VERSION'};
  const items=Array.from({length:count},(_,i)=>({itemName:'Item '+i}));
  let opened,rendered=0;
  const c=vm.createContext({window:{},currentUser:{uid:'ADMIN'},currentUserRole:'admin',currentUserName:'Admin',currentUserCode:'A',
   forecastCache:[forecast],forecastOrderItems:async()=>items,forecastItemToOrderSource:(f,item)=>({...item,sourceId:f.id}),
   normalizeNewOrderItem:item=>item,openOrderModal:item=>{opened=item;},renderNewOrderDraftItems:()=>rendered++,
   alert:message=>{throw Error(message);},console});
  vm.runInContext(forecastFeature.slice(forecastFeature.indexOf('window.createOrderFromForecast')),c);
  await c.window.createOrderFromForecast('F');
  assert.equal(opened.sourceId,'F');assert.equal(c.newOrderDraftItems.length,count-1);assert.equal(rendered,1);
  assert.deepEqual(plain(c.window._orderModalForecastContext),{id:'F',updatedAt:'VERSION',ownerUid:'OWNER',salesName:'Owner',salesCode:'S01'});
 }
});

test('order form adopts an older Forecast pending ID and keeps it through a lost response',async()=>{
 const f=fixture(),feature=fs.readFileSync('src/features/orders/order-creation.js','utf8');
 Object.assign(f.c,{window:{_orderModalForecastContext:{id:'F',updatedAt:'V'}},ORDER_DRAFT_STORAGE_PREFIX:'draft',
  localStorage:{getItem:k=>f.stored.get(k)||null,setItem:(k,v)=>f.stored.set(k,v),removeItem:k=>f.stored.delete(k)}});
 vm.runInContext(feature.slice(feature.indexOf('function orderDraftStorageKey'),feature.indexOf('function orderDraftFieldValue')),f.c);
 f.stored.set('draft:U:forecast:F:pending_order_id','LEGACY');f.state.lost=true;
 await assert.rejects(f.c.createOrResumeNewOrder(f.forecast),/lost reply/);
 assert.equal(f.stored.get('draft:U:pending_order_id'),'LEGACY');
 const result=await f.c.createOrResumeNewOrder(f.forecast);
 assert.equal(result.id,'LEGACY');assert.equal(f.stored.has('draft:U:forecast:F:pending_order_id'),false);
 assert.deepEqual(f.writes,[['set','orders/LEGACY'],['update','forecasts/F']]);
});

test('new order allows fifteen lines, rejects sixteen before writes and resumes legacy orders',async()=>{
 const f=fixture();const items=Array.from({length:15},()=>({qty:1}));
 await f.c.commitOrderCreation('FIFTEEN',{...f.data,items});
 const before=f.writes.length;
 await assert.rejects(f.c.commitOrderCreation('SIXTEEN',{...f.data,items:[...items,{qty:1}]}),/15/);
 assert.equal(f.writes.length,before);assert.equal(f.docs.has('orders/SIXTEEN'),false);
 f.docs.set('orders/LEGACY',{...f.data,items:[...items,{qty:1}],inventoryReservationStatus:'completed'});
 const result=await f.c.commitOrderCreation('LEGACY',{...f.data,items});
 assert.equal(result.data.items.length,16);assert.equal(f.writes.length,before);
});
