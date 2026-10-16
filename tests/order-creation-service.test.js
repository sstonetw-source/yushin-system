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
 const c=vm.createContext({currentUser:{uid:'U'},currentUserRole:'sales',BUSINESS_STATUS:{ACTIVE:'active'},
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
 const data={createdByUid:'U',status:'active',ownerUid:'U',createdAt:'T',inventoryReservationStatus:'pending'};
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
 f.convert=()=>c.createForecastOrdersDirectly({id:'F',ownerUid:'U',updatedAt:'V'},[{itemName:'Item',productId:'P',productMasterMatched:true}]);
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
