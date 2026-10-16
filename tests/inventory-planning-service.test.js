const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const core=require('../modules/inventory-core'),source=fs.readFileSync('src/services/inventory-planning.js','utf8'),feature=fs.readFileSync('src/features/inventory/inventory-workspace.js','utf8');
const plain=x=>JSON.parse(JSON.stringify(x));
function fixture({role='admin',archived=false}={}){
 const docs=new Map([['inventory/I',{productKey:'P',productId:'P',onHand:0,reserved:0,incoming:0,listArchived:archived,stockPolicy:'ORDER_ONLY',safetyStock:0}]]),reads=[],writes=[],queries=[];
 const state={fail:false,lost:false,replay:false,beforeReplay:null,afterRead:null,afterCommit:null};
 const ref=(col,id)=>({id,path:col+'/'+id});
 const c=vm.createContext({YushinInventory:core,currentUser:{uid:'U'},currentUserRole:role,trueUserRole:role,firestoreReadWithTimeout:p=>p,
  db:{collection:col=>({doc:id=>ref(col,id),where:(field,_op,value)=>({limit:max=>({get:async()=>{queries.push(col);assert.equal(max,201);
   const rows=[...docs].filter(([p,d])=>p.startsWith(col+'/')&&d[field]===value).slice(0,max);return {size:rows.length,docs:rows.map(([p])=>({ref:ref(col,p.split('/')[1])}))};}})})})},
  runRoleTransaction:async fn=>{let staged=[];const tx={get:async r=>{assert.equal(staged.length,0,'all reads precede writes');reads.push(r.path);const data=docs.get(r.path);state.afterRead?.(r);return {exists:!!data,data:()=>plain(data)};},
   update:(r,d)=>staged.push([r.path,plain(d),true]),set:(r,d)=>staged.push([r.path,plain(d),false])};
   if(state.replay){await fn(tx);staged=[];state.beforeReplay?.();}await fn(tx);if(state.fail)throw Error('commit failed');
   for(const [p,d,merge] of staged){docs.set(p,{...(merge?docs.get(p):{}),...d});writes.push(p);}state.afterCommit?.();if(state.lost){state.lost=false;throw Error('lost reply');}
  }});
 vm.runInContext(source,c);
 const archive={inventoryId:'I',productKey:'P',archived:true,operationId:'ARCHIVE'};
 return {c,docs,reads,writes,queries,state,archive,plan:(policy='SAFETY_STOCK',qty=5,options={})=>c.commitInventoryPlanningSettings('I',policy,qty,{operationId:'PLAN',...options}),hide:(input=archive,options={})=>c.commitInventoryListArchive(input,options)};
}
test('planning core owns enum, numeric validation and stale safety clearing',()=>{
 assert.deepEqual(core.planningSettings('safety_stock','5'),{stockPolicy:'SAFETY_STOCK',safetyStock:5});assert.deepEqual(core.planningSettings('NO_STOCK',99),{stockPolicy:'NO_STOCK',safetyStock:0});
 for(const value of [0,-1,'',null,false,NaN,Infinity,[],{}])assert.throws(()=>core.planningSettings('SAFETY_STOCK',value));
 assert.throws(()=>core.planningSettings('OTHER',5));assert.equal(core.stockIsEmpty({transferFreeInTransit:1}),false);
});
test('policy and receipt commit atomically without touching physical quantities',async()=>{
 const f=fixture({role:'purchaser'});await f.plan();const live=f.docs.get('inventory/I'),audit=f.docs.get('auditLogs/PLAN');
 assert.equal(live.stockPolicy,'SAFETY_STOCK');assert.equal(live.safetyStock,5);assert.equal(live.onHand,0);assert.equal(audit.actorRole,'purchaser');assert.equal(audit.previousStockPolicy,'ORDER_ONLY');assert.equal(audit.changed,true);
 assert.equal(live.updatedAt,audit.createdAt);assert.equal(f.writes.length,2);
});
test('policy lost-response retry preserves later settings and returns current facts',async()=>{
 const f=fixture();f.state.lost=true;await assert.rejects(f.plan(),/lost reply/);
 Object.assign(f.docs.get('inventory/I'),{stockPolicy:'NO_STOCK',safetyStock:0,updatedAt:'LATER'});
 const before=JSON.stringify([...f.docs]),r=await f.plan();assert.equal(r.replayed,true);assert.equal(r.patch.stockPolicy,'NO_STOCK');assert.equal(r.patch.updatedAt,'LATER');assert.equal(JSON.stringify([...f.docs]),before);
});
test('no-change policy keeps an explicit receipt and cannot overwrite a later change on replay',async()=>{
 const f=fixture();await f.plan('ORDER_ONLY',0);assert.deepEqual(f.writes,['auditLogs/PLAN']);assert.equal(f.docs.get('auditLogs/PLAN').changed,false);
 Object.assign(f.docs.get('inventory/I'),{stockPolicy:'SAFETY_STOCK',safetyStock:9});assert.equal((await f.plan('ORDER_ONLY',0)).patch.safetyStock,9);assert.equal(f.writes.length,1);
});
test('policy same ID refuses changed intent actor or role',async()=>{
 for(const change of [f=>f.c.currentUser={uid:'OTHER'},f=>f.c.currentUserRole='purchaser']){const f=fixture();await f.plan();change(f);await assert.rejects(f.plan(),/其他內容或身分/);assert.equal(f.writes.length,2);}
 const f=fixture();await f.plan();await assert.rejects(f.plan('SAFETY_STOCK',6),/其他內容或身分/);
});
test('policy permission identity and malformed input guards precede writes',async()=>{
 for(const role of ['warehouse','sales','engineer']){const f=fixture({role});await assert.rejects(f.plan(),/管理員或採購/);assert.equal(f.reads.length,0);}
 const f=fixture();await assert.rejects(f.plan('SAFETY_STOCK',''));await assert.rejects(f.c.commitInventoryPlanningSettings('I','NO_STOCK',0,{operationId:'a/b'}));assert.equal(f.reads.length,0);
});
test('archive transition includes zero inactive warehouses and authoritative lots and atomic audit',async()=>{
 const f=fixture();f.docs.set('warehouseStocks/OFF',{productKey:'P',onHand:0,reserved:0,incoming:0,active:false});f.docs.set('inventoryLots/L',{productKey:'P',remainingQty:0});
 const r=await f.hide();assert.equal(r.patch.listArchived,true);assert.deepEqual(f.queries.sort(),['inventoryLots','warehouseStocks']);assert.equal(f.docs.get('inventory/I').listArchiveAuditId,'ARCHIVE');assert.equal(f.docs.get('auditLogs/ARCHIVE').changed,true);
 assert.equal(f.reads.includes('inventoryLots/L'),true);assert.equal(f.reads.includes('warehouseStocks/OFF'),true);
});
test('archive lost-response replay does not rearchive after a later restore or new receipt',async()=>{
 const f=fixture();f.state.lost=true;await assert.rejects(f.hide(),/lost reply/);Object.assign(f.docs.get('inventory/I'),{listArchived:false,onHand:4});
 const before=JSON.stringify([...f.docs]);f.queries.length=0;const r=await f.hide();assert.equal(r.patch.listArchived,false);assert.equal(r.replayed,true);assert.equal(JSON.stringify([...f.docs]),before);assert.equal(f.queries.length,0);
});
test('restore leaves stock untouched and already-restored operations still receive one receipt',async()=>{
 const f=fixture({archived:true});f.docs.get('inventory/I').onHand=10;await f.hide({...f.archive,archived:false});assert.equal(f.docs.get('inventory/I').onHand,10);assert.equal(f.queries.length,0);
 const g=fixture();await g.hide({...g.archive,archived:false});assert.deepEqual(g.writes,['auditLogs/ARCHIVE']);await g.hide({...g.archive,archived:false});assert.equal(g.writes.length,1);
});
test('archive refuses nonzero malformed or conflicting stock, raw lot values and excessive collections',async()=>{
 for(const change of [f=>f.docs.get('inventory/I').incoming=1,f=>f.docs.get('inventory/I').transferFreeInTransit=1,
  f=>f.docs.set('warehouseStocks/W',{productKey:'P',reserved:1}),f=>f.docs.set('warehouseStocks/W',{productKey:'P',onHand:'bad'}),
  f=>f.docs.set('inventoryLots/L',{productKey:'P',remainingQty:null}),f=>f.docs.set('inventoryLots/L',{productKey:'P',remainingQty:-1}),
  f=>f.docs.set('inventoryLots/L',{productKey:'P',remainingQty:1}),f=>{for(let i=0;i<201;i++)f.docs.set('inventoryLots/L'+i,{productKey:'P',remainingQty:0});}]){
  const f=fixture();change(f);const before=JSON.stringify([...f.docs]);await assert.rejects(f.hide());assert.equal(JSON.stringify([...f.docs]),before);assert.equal(f.writes.length,0);
 }
});
test('archive callback replay rediscovers a newly created nonempty warehouse before committing',async()=>{
 const f=fixture();f.state.replay=true;f.state.beforeReplay=()=>f.docs.set('warehouseStocks/NEW',{productKey:'P',onHand:1});
 await assert.rejects(f.hide(),/倉庫庫存/);assert.equal(f.writes.length,0);assert.equal(f.queries.filter(q=>q==='warehouseStocks').length,2);
});
test('archive only accepts true admin and matching ID product intent',async()=>{
 for(const role of ['purchaser','warehouse','sales','engineer']){const f=fixture({role});await assert.rejects(f.hide(),/管理員視角/);assert.equal(f.reads.length,0);}
 const f=fixture();f.c.trueUserRole='purchaser';await assert.rejects(f.hide());assert.equal(f.reads.length,0);
 const g=fixture();await g.hide();await assert.rejects(g.hide({...g.archive,archived:false}),/其他內容或身分/);
});
test('callback retries use one timestamp and one final audit; atomic failures leave no receipt',async()=>{
 const f=fixture();f.state.replay=true;await f.plan();assert.equal(f.writes.filter(p=>p.startsWith('auditLogs')).length,1);assert.equal(f.docs.get('inventory/I').updatedAt,f.docs.get('auditLogs/PLAN').createdAt);
 for(const kind of ['plan','hide']){const g=fixture();g.state.fail=true;const before=JSON.stringify([...g.docs]);await assert.rejects(g[kind]());assert.equal(JSON.stringify([...g.docs]),before);}
});
test('midread switches fail before writes and postcommit switches mark committed facts',async()=>{
 for(const kind of ['plan','hide']){
  const f=fixture();f.state.afterRead=()=>{f.c.currentUserRole='sales';};await assert.rejects(f[kind]());assert.equal(f.writes.length,0);
  const g=fixture();g.state.afterCommit=()=>{g.c.currentUserRole='sales';};await assert.rejects(g[kind](),e=>kind==='plan'?e.inventoryPlanningCommitted===true:e.inventoryListCommitted===true);assert.equal(g.writes.length,2);
 }
});
function uiFixture(){
 const f=fixture(),messages=[],item={id:'I',...f.docs.get('inventory/I')};let seq=0;
 Object.assign(f.c,{inventoryCache:[item],inventorySearchResults:[],inventoryReplenishmentCache:[],inventoryItemById:()=>item,inventoryAggregateStock:()=>item,
  lifecycleRecordId:()=> 'OP'+(++seq),canManageInventoryStockPolicy:()=>['admin','purchaser'].includes(f.c.currentUserRole),INVENTORY_STOCK_POLICIES:core.STOCK_POLICIES,
  confirm:()=>true,beginActionButton:()=>({}),endActionButton(){},alert:m=>messages.push(m),showActionFeedback:m=>messages.push(m),writeAppDataCache(){},markMainPageDirty(){},renderInventoryList(){},renderInventoryReplenishmentCenter(){}});
 f.c.window=f.c;vm.runInContext(feature.slice(feature.indexOf('function canManageInventoryList()'),feature.indexOf('window.setInventoryStockPolicy=')),f.c);
 return {...f,messages,item};
}
test('Feature keeps policy operation after lost response and does not overwrite later current cache',async()=>{
 const f=uiFixture();f.state.lost=true;await assert.rejects(f.c.saveInventoryPlanningSettings('I','SAFETY_STOCK',5));
 await assert.rejects(f.c.saveInventoryPlanningSettings('I','SAFETY_STOCK',6),/原身分及原內容/);
 Object.assign(f.docs.get('inventory/I'),{stockPolicy:'NO_STOCK',safetyStock:0});await f.c.saveInventoryPlanningSettings('I','SAFETY_STOCK',5);
 assert.equal(f.item.stockPolicy,'NO_STOCK');assert.equal(f.writes.length,2);
});
test('Feature archive cache failure retains receipt ID and retry never adds a second audit',async()=>{
 const f=uiFixture();f.c.writeAppDataCache=()=>{throw Error('cache failed');};await f.c.setInventoryListArchived('I',true,{});assert.match(f.messages[0],/已提交/);
 f.c.writeAppDataCache=()=>{};await f.c.setInventoryListArchived('I',true,{});assert.equal(f.writes.length,2);assert.match(f.messages.at(-1),/原列表操作已確認/);
});
test('Feature pending archive confirms the old receipt after a later restore and stock receipt',async()=>{
 const f=uiFixture();f.state.lost=true;await f.c.setInventoryListArchived('I',true,{});
 Object.assign(f.docs.get('inventory/I'),{listArchived:false,onHand:5});Object.assign(f.item,{listArchived:false,onHand:5});
 await f.c.setInventoryListArchived('I',true,{});
 assert.equal(f.writes.length,2);assert.equal(f.item.listArchived,false);assert.equal(f.docs.get('inventory/I').onHand,5);
 assert.match(f.messages.at(-1),/原列表操作已確認/);
 await f.c.setInventoryListArchived('I',true,{});assert.match(f.messages.at(-1),/必須為 0/);assert.equal(f.writes.length,2);
});
test('Feature duplicate policy save is blocked and actor switches cannot update cache or feedback',async()=>{
 const f=uiFixture(),original=f.c.commitInventoryPlanningSettings;let release;const gate=new Promise(r=>release=r);
 f.c.commitInventoryPlanningSettings=async(...args)=>{await gate;return original(...args);};
 const one=f.c.saveInventoryPlanningSettings('I','SAFETY_STOCK',5);await assert.rejects(f.c.saveInventoryPlanningSettings('I','SAFETY_STOCK',5),/正在儲存/);release();await one;assert.equal(f.writes.length,2);
 const g=uiFixture();g.state.afterCommit=()=>{g.c.currentUser={uid:'OTHER'};};await g.c.setInventoryListArchived('I',true,{});assert.equal(g.item.listArchived,false);assert.equal(g.messages.length,0);
});
test('Feature policy rendering failure retains the original receipt and classifies committed data',async()=>{
 const f=uiFixture();f.c.renderInventoryList=()=>{throw Error('render failed');};
 await assert.rejects(f.c.saveInventoryPlanningSettings('I','SAFETY_STOCK',5),e=>e.inventoryPlanningCommitted===true);
 f.c.renderInventoryList=()=>{};await f.c.saveInventoryPlanningSettings('I','SAFETY_STOCK',5);assert.equal(f.writes.length,2);
});
test('late settings modal completion does not close or notify a different newly opened editor',async()=>{
 const f=uiFixture(),nodes={inventoryPolicySettingSelect:{value:'SAFETY_STOCK'},inventorySafetyStockSetting:{value:'5'},saveInventoryPolicySettingsBtn:{}};
 f.c.document={getElementById:id=>nodes[id]||null};vm.runInContext(feature.slice(feature.indexOf("let inventoryPolicyEditingId='';"),feature.indexOf('window.renderPendingInventoryItems=')),f.c);
 vm.runInContext("inventoryPolicyEditingId='I';inventoryPolicyEditorGeneration=1;",f.c);
 let release,closed=0;const gate=new Promise(r=>release=r),original=f.c.commitInventoryPlanningSettings;
 f.c.commitInventoryPlanningSettings=async(...args)=>{await gate;return original(...args);};f.c.closeInventoryPolicySettings=()=>{closed++;};
 const pending=f.c.saveInventoryPolicySettings();vm.runInContext("inventoryPolicyEditingId='NEXT';inventoryPolicyEditorGeneration++;",f.c);release();await pending;
 assert.equal(closed,0);assert.equal(f.messages.length,0);assert.equal(f.docs.get('inventory/I').safetyStock,5);
});
test('planning Service has no UI cache dependency and Feature contains no policy or archive writes',()=>{
 assert.doesNotMatch(source,/\b(?:window|document|localStorage)\s*\.|\b(?:inventoryCache|applyInventoryPlanningPatchToCaches|renderInventoryList|canManageInventoryList)\b/);
 const ui=feature.slice(feature.indexOf('function canManageInventoryList()'),feature.indexOf('window.renderPendingInventoryItems='));assert.doesNotMatch(ui,/runRoleTransaction|db\.collection|\.update\(/);
 assert.match(ui,/commitInventoryPlanningSettings/);assert.match(ui,/commitInventoryListArchive/);
});
