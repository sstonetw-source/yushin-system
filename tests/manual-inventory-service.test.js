'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const service=fs.readFileSync('src/services/manual-inventory.js','utf8');
const transport=fs.readFileSync('src/services/manual-stock-transport.js','utf8');
const feature=fs.readFileSync('src/features/inventory/inventory-workspace.js','utf8');
const batch=feature.slice(feature.indexOf('window.saveInventoryAdjustmentBatch ='),feature.indexOf('function inventoryProductKey'));

function serviceFixture({role='purchaser'}={}){
 const calls=[],ctx=vm.createContext({currentUser:{uid:'U'},currentUserRole:role,Number,
  commitManualStockBackend:async(...args)=>{calls.push(args);return {status:'applied',operationId:args[1].operationId};}});
 vm.runInContext(service,ctx);return {ctx,calls};
}
test('browser service delegates intent to backend; does not mutate stock ledgers',()=>{
 assert.doesNotMatch(service,/runRoleTransaction|db\.collection|\btx\.(?:get|set|update|create)\b/);
 assert.match(service,/commitManualStockBackend\('MANUAL_INVENTORY'/);
 assert.match(batch,/await commitManualInventoryAdjustment\(/);
 assert.doesNotMatch(batch,/runRoleTransaction|\btx\.(?:set|update)|db\.collection/);
});
test('manual wrapper sends only business intent and protected initial cost to admin/purchaser',async()=>{
 for(const role of ['admin','purchaser']){
  const f=serviceFixture({role});await f.ctx.commitManualInventoryAdjustment({type:'initial',productKey:'P',warehouseId:'W',operationId:'op-123456789',
   row:{qty:3,unitCost:0,lotNo:'B',expiryDate:'2027-01-01',itemName:'untrusted',brand:'spoof',actorUid:'OTHER'}},
   {actorUid:'U',actorRole:role});
  assert.equal(f.calls.length,1);const [kind,payload,options]=f.calls[0];
  assert.equal(kind,'MANUAL_INVENTORY');assert.deepEqual(Object.keys(payload).sort(),
   ['expiryDate','lotNo','operationId','productKey','qty','type','unitCost','warehouseId'].sort());
  assert.equal(payload.unitCost,0);assert.equal(payload.qty,3);assert.equal(payload.itemName,undefined);
  assert.equal(options.actorUid,'U');
 }
});
test('warehouse has no cost field, and scrap/adjustment never send protected cost',async()=>{
 const wh=serviceFixture({role:'warehouse'});
 await wh.ctx.commitManualInventoryAdjustment({type:'initial',productKey:'P',warehouseId:'W',operationId:'op-123456789',
  row:{qty:2,unitCost:'',lotNo:'',expiryDate:''}});
 assert.equal('unitCost' in wh.calls[0][1],false);
 for(const type of ['adjustment','scrap']){
  const f=serviceFixture();await f.ctx.commitManualInventoryAdjustment({type,productKey:'P',warehouseId:'W',operationId:'op-123456789',
   row:{qty:type==='scrap'?3:-3,unitCost:999}});
  assert.equal('unitCost' in f.calls[0][1],false);
 }
});
test('missing initial actual cost stops before backend invocation',async()=>{
 const f=serviceFixture();await assert.rejects(f.ctx.commitManualInventoryAdjustment({type:'initial',productKey:'P',warehouseId:'W',operationId:'op-123456789',
  row:{qty:1,unitCost:''}}),/成本/);assert.equal(f.calls.length,0);
});

function batchFixture(){
 const messages=[],calls=[],buttons={disabled:false},c=vm.createContext({currentUser:{uid:'U'},currentUserRole:'purchaser',currentUserName:'User',
  inventoryAdjustmentSaveInProgress:false,inventoryAdjustmentGeneration:1,
  inventoryAdjustmentRows:[{productId:'P',itemCode:'CODE',brand:'B',warehouseId:'W',qty:3,unitCost:0},
   {productId:'P',itemCode:'CODE',brand:'B',warehouseId:'W',qty:2,unitCost:0}],
  document:{getElementById:id=>id==='inventoryAdjustmentType'?{value:'initial'}:buttons},canEditPage:()=>true,
  canCreatePurchaseOrderCapability:()=>true,findPriceItemByCodeValue:()=>null,stableProductId:row=>row.productId,
  lifecycleRecordId:(()=>{let n=0;return()=> 'op-12345678'+(++n);})(),
  commitManualInventoryAdjustment:async(req)=>{calls.push(req);return {operationId:req.operationId,replayed:false};},
  invalidateWarehouseStockCache(){},loadInventory:async()=>{},renderInventoryAdjustmentRows(){},
  closeInventoryAdjustment(){c.inventoryAdjustmentGeneration++;},alert:message=>messages.push(message),console:{error(){}}});
 c.window=c;vm.runInContext(batch,c);return {c,calls,messages,buttons};
}
test('batch keeps per-row operation IDs when reply is uncertain and never resends successful rows',async()=>{
 const f=batchFixture();let unknown=true;f.c.commitManualInventoryAdjustment=async req=>{
  f.calls.push(req);if(req.row.qty===2&&unknown){unknown=false;throw Error('回覆不明');}
  return {operationId:req.operationId};
 };
 await f.c.saveInventoryAdjustmentBatch();
 assert.equal(f.c.inventoryAdjustmentRows.length,1);
 assert.equal(f.c.inventoryAdjustmentRows[0].operationId,'op-123456782');
 await f.c.saveInventoryAdjustmentBatch();
 assert.equal(f.calls.length,3);assert.equal(f.calls[2].operationId,'op-123456782');
 assert.equal(f.c.inventoryAdjustmentRows.length,1); // close is presentation only in this fixture
});
test('batch prevents double submission, validates actor and stops if session changes',async()=>{
 const f=batchFixture();let release;const gate=new Promise(resolve=>release=resolve);
 f.c.commitManualInventoryAdjustment=async req=>{f.calls.push(req);await gate;f.c.currentUser={uid:'OTHER'};};
 const first=f.c.saveInventoryAdjustmentBatch();await f.c.saveInventoryAdjustmentBatch();assert.equal(f.calls.length,1);
 release();await first;assert.equal(f.calls.length,1);assert.equal(f.c.inventoryAdjustmentSaveInProgress,false);
});

test('interrupted backend reply retains exact intent across reload and recovers its receipt without a second stock writer',async()=>{
 const values=new Map(),storage={get length(){return values.size;},key:i=>[...values.keys()][i]||null,
  getItem:key=>values.has(key)?values.get(key):null,setItem:(key,value)=>values.set(key,String(value)),removeItem:key=>values.delete(key)};
 const project='preview-20135',uid='U',role='purchaser';let serverCalls=0,reads=0,failFirst=true;
 const payload={operationId:'op-123456789012',productKey:'P',warehouseId:'W',type:'initial',qty:5,lotNo:'',expiryDate:'',unitCost:0};
 const fn={app:{options:{projectId:project}},httpsCallable:()=>async intent=>{
  serverCalls++;assert.equal(intent.operationId,payload.operationId);
  if(failFirst){failFirst=false;throw Error('timeout after commit');}
  return {data:{status:'already-applied',operationId:payload.operationId,productKey:'P',warehouseId:'W',actorUid:uid,actorRole:role,delta:5}};
 }};
 const auth={currentUser:{uid},app:{options:{projectId:project}}},app={options:{projectId:project},functions:()=>fn};
 const c=vm.createContext({currentUser:{uid},currentUserRole:role,APP_ENVIRONMENT:'preview',
  YUSHIN_PREVIEW_MANUAL_STOCK:true,location:{hostname:'preview-20135.web.app',origin:'https://preview-20135.web.app',pathname:'/'},
  firebase:{auth:()=>auth,functions:()=>fn,app:()=>app},db:{app:{options:{projectId:project}},collection:name=>{
   assert.equal(name,'inventoryMovements');return {doc:id=>{assert.equal(id,payload.operationId);return {get:async opts=>{
    reads++;assert.equal(opts.source,'server');return {exists:true,data:()=>({sourceId:id,productKey:'P',warehouseId:'W',actorUid:uid,
     actorRole:role,qty:5,intentHash:'from-server',operation:'manual-adjustment'})};}};}};
  }},sessionStorage:storage,canEditPage:()=>true,
  ensureReservationFunctionsCompat:async()=>{},invalidateWarehouseStockCache:()=>{},console});
 vm.runInContext(transport,c);
 await assert.rejects(c.commitManualStockBackend('MANUAL_INVENTORY',payload,{actorUid:uid,actorRole:role}),/timeout/);
 assert.equal(storage.length,1);assert.equal(reads,0);
 assert.equal(c.manualStockPendingOperations().length,1);
 const restored=await c.resolveManualStockPendingOperations();
 assert.equal(restored,1);assert.equal(serverCalls,2);assert.equal(reads,1);assert.equal(storage.length,0);
 assert.equal(c.manualStockPendingOperations().length,0);
});
