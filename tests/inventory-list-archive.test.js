const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const path=require('node:path'),core=require('../modules/inventory-core.js');
const src=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const code=src.slice(src.indexOf('function canManageInventoryList()'),src.indexOf('function applyInventoryPlanningPatchToCaches'));
test('archive hides only empty stock and automatically shows new stock or reservations',()=>{
 const empty={onHand:0,reserved:0,incoming:0,listArchived:true,lots:[{qty:0}]};
 assert.equal(core.isListArchived(empty),true);
 for(const key of ['onHand','reserved','incoming']){
  assert.equal(core.isListArchived({...empty,[key]:1}),false);
  assert.equal(core.isListArchived(empty,{[key]:1}),false);
 }
 for(const value of [-1,'invalid',Infinity,NaN,false,null,'   '])assert.equal(core.stockIsEmpty({onHand:value}),false);
 assert.equal(core.stockIsEmpty({lots:[{remainingQty:2,qty:0}]}),false);
 assert.equal(core.isListArchived({...empty,listArchived:false}),false);
});
function setup({live={},warehouses=[],role='admin',fail=false}={}){
 const item={id:'I1',productKey:'P1',onHand:0,reserved:0,incoming:0},events=[],storage={...item,...live};
 const auditRef={id:'audit1'},inventoryRef={id:'I1'};
 let release;const gate=new Promise(resolve=>{release=resolve});
 const x=vm.createContext({window:{},YushinInventory:core,trueUserRole:'admin',currentUserRole:role,currentUser:{uid:'admin'},
  inventoryItemById:()=>item,inventoryAggregateStock:()=>({onHand:0,reserved:0,incoming:0}),
  confirm:()=>true,alert:message=>events.push(['alert',message]),beginActionButton:()=>({}),endActionButton(){},
  firestoreReadWithTimeout:p=>p,db:{collection:name=>({doc:()=>name==='inventory'?inventoryRef:auditRef,
   where:()=>({limit:()=>({get:async()=>({size:warehouses.length,docs:warehouses.map((data,i)=>({ref:{id:'W'+i,data}}))})})})}),
   runTransaction:async fn=>{events.push('transaction');await gate;if(fail)throw Error('offline');const writes=[];
    const result=await fn({get:async ref=>({exists:true,data:()=>ref===inventoryRef?storage:ref.data}),
     update:(ref,patch)=>writes.push(['update',patch]),set:(ref,data)=>writes.push(['audit',data])});
    events.push(...writes);for(const [kind,patch]of writes)if(kind==='update')Object.assign(storage,patch);return result;}},
  applyInventoryPlanningPatchToCaches:(id,patch)=>Object.assign(item,patch),loadInventory:async()=>events.push('refresh'),
  writeAppDataCache(){},inventoryCache:[],markMainPageDirty(){},renderInventoryList(){},renderInventoryReplenishmentCenter(){},showActionFeedback:message=>events.push(['success',message])});
 vm.runInContext("globalThis.runRoleTransaction ||= callback => db.runTransaction(callback); globalThis.supplyOrdersCollection ||= () => db.collection('supplyOrders'); globalThis.syncReceivingSupplyViews ||= () => {};", x);
vm.runInContext(code,x);return {x,events,item,storage,release,run:archived=>x.window.setInventoryListArchived('I1',archived,{})};
}
test('archive atomically records audit and suppresses double click',async()=>{
 const a=setup(),p=a.run(true);await a.run(true);a.release();await p;
 assert.equal(a.events.filter(e=>e==='transaction').length,1);
 assert.equal(a.events.filter(e=>e[0]==='audit').length,1);
 assert.equal(a.item.listArchived,true);assert.equal(a.storage.listArchiveAuditId,'audit1');
 assert.equal(a.events.find(e=>e[0]==='audit')[1].action,'inventory_list_archive');
});
test('cloud stock race, inactive warehouse stock and failures leave data unchanged',async()=>{
 for(const opts of [{live:{reserved:1}},{warehouses:[{onHand:2}]},{warehouses:[{incoming:1}]},{fail:true}]){
  const a=setup(opts),p=a.run(true);a.release();await p;
  assert.equal(a.storage.listArchived,undefined);assert.equal(a.item.listArchived,undefined);
  assert.equal(a.events.some(e=>e[0]==='audit'),false);assert.equal(a.events.some(e=>e[0]==='alert'),true);
 }
});
test('restore retains all stock and emits audit; purchaser cannot archive',async()=>{
 const a=setup({live:{listArchived:true}}),p=a.run(false);a.release();await p;
 assert.equal(a.storage.listArchived,false);assert.equal(a.storage.onHand,0);
 assert.equal(a.events.find(e=>e[0]==='audit')[1].action,'inventory_list_restore');
 const b=setup({role:'purchaser'});await b.run(true);assert.equal(b.events.includes('transaction'),false);
});
test('repeated archived request does not create duplicate audit',async()=>{
 const a=setup({live:{listArchived:true}}),p=a.run(true);a.release();await p;
 assert.equal(a.events.some(e=>e[0]==='audit'),false);
});
test('quantity validation, excessive warehouse rows and role change fail safely',async()=>{
 const a=setup();a.item.onHand=1;await a.run(true);assert.equal(a.events.includes('transaction'),false);
 const b=setup({warehouses:Array.from({length:201},()=>({onHand:0}))});await b.run(true);
 assert.equal(b.events.includes('transaction'),false);
 const c=setup(),p=c.run(true);c.x.currentUserRole='sales';c.release();await p;
 assert.equal(c.events.some(e=>e[0]==='audit'),false);
});
test('archived zero stock suspends replenishment until restored or stock returns',()=>{
 const start=src.indexOf('function inventoryReplenishmentPlan('),end=src.indexOf('let inventoryReplenishmentError',start);
 const x=vm.createContext({YushinInventory:core,inventoryStockPolicy:item=>item.stockPolicy,
  inventoryProjectedStock:stock=>(stock.onHand||0)-(stock.reserved||0)+(stock.incoming||0),
  INVENTORY_STOCK_POLICIES:{SAFETY_STOCK:'SAFETY_STOCK'}});
 vm.runInContext("globalThis.runRoleTransaction ||= callback => db.runTransaction(callback); globalThis.supplyOrdersCollection ||= () => db.collection('supplyOrders'); globalThis.syncReceivingSupplyViews ||= () => {};", x);
vm.runInContext(src.slice(start,end),x);
 const item={listArchived:true,onHand:0,reserved:0,incoming:0,stockPolicy:'SAFETY_STOCK',safetyStock:5};
 assert.equal(x.inventoryReplenishmentPlan(item,{}).needsReplenishment,false);
 assert.equal(x.inventoryReplenishmentPlan({...item,listArchived:false},{}).suggestedQty,5);
 assert.equal(x.inventoryReplenishmentPlan(item,{incoming:1}).suggestedQty,4);
});
