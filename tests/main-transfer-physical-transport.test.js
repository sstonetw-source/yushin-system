'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function fixture(){
 const storage=new Map(),calls=[];let transfer=null,lose=false,after=()=>{},bad=false,failRead=false;
 const id='transfer_12345678',requestId='request_12345678';
 const open=()=>{
  const options={projectId:'preview-20135'},auth={app:{options},currentUser:{uid:'U'}};
  const functions={app:{options},useEmulator:()=>{throw Error('Preview emulator');},httpsCallable:name=>async payload=>{
   calls.push({name,payload:structuredClone(payload)});const action=name==='dispatchV2MainTransfer'?'DISPATCH':'RECEIVE';
   if(action==='DISPATCH')transfer??={id:payload.id,requestId:payload.requestId,kind:'TRANSFER',orderId:'',dispatchIntentHash:'hash',status:'IN_TRANSIT',qty:3,createdByUid:'U',createdByRole:'warehouse'};
   else Object.assign(transfer,{status:'RECEIVED',receivedByUid:'U',receivedByRole:'warehouse',receiptOperationId:payload.operationId,receiptIntentHash:'hash',allocationCompleted:false});
   if(lose){lose=false;throw Error('reply lost');}after(c);
   return {data:{action,id:payload.id,operationId:bad?'wrong':action==='DISPATCH'?payload.id:payload.operationId,status:'already-applied',actorUid:'U',actorRole:'warehouse'}};
  }};
  const c=vm.createContext({APP_ENVIRONMENT:'preview',YUSHIN_PREVIEW_MAIN_TRANSFER_DISPATCH:true,YUSHIN_PREVIEW_MAIN_TRANSFER_RECEIPT:true,
   currentUser:{uid:'U'},currentUserRole:'warehouse',location:{hostname:'preview-20135.web.app'},lifecycleRecordId:()=> 'receipt_12345678',
   firebase:{auth:()=>auth,functions:()=>{},app:()=>({options,functions:()=>functions})},
   db:{app:{options:{projectId:'preview-20135'}},collection:()=>({doc:()=>({get:async()=>{if(failRead)throw Error('read failed');return {exists:!!transfer,data:()=>structuredClone(transfer)};}})})},
   canReceiveInventoryCapability:()=>true,canAccessPage:()=>true,runRoleTransaction:()=>{throw Error('legacy writer called');},
   pendingMainTransferOperation:()=>null,
   sessionStorage:{get length(){return storage.size;},key:n=>[...storage.keys()][n],getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}});
  for(const file of ['main-transfer-request-transport','main-transfer-physical-transport','warehouse-transfer'])vm.runInContext(fs.readFileSync('src/services/'+file+'.js','utf8'),c);
  return c;
 };
 return {storage,calls,id,requestId,open,setLose:v=>lose=v,setAfter:f=>after=f,setBad:v=>bad=v,setFailRead:v=>failRead=v,getTransfer:()=>transfer};
}
test('dispatch survives lost reply and reload with original ID; same request cannot create a new operation',async()=>{
 const f=fixture(),c=f.open();f.setLose(true);
 await assert.rejects(c.commitWarehouseTransfer({id:f.id,requestId:f.requestId,qty:3}),/reply lost/);
 assert.equal(f.storage.size,1);const resumed=f.open();assert.equal(resumed.pendingMainTransferDispatch(f.requestId).id,f.id);
 await assert.rejects(resumed.commitWarehouseTransfer({id:'different_12345678',requestId:f.requestId,qty:3}),/原操作識別碼/);
 assert.equal(f.calls.length,1);await resumed.commitMainTransferPhysicalBackend('DISPATCH',f.id);
 assert.deepEqual(f.calls[0],f.calls[1]);assert.equal(f.storage.size,0);
});
test('receipt replay confirms original event, reports allocation pending and never calls legacy allocation',async()=>{
 const f=fixture(),c=f.open();await c.commitWarehouseTransfer({id:f.id,requestId:f.requestId,qty:3});f.setLose(true);
 await assert.rejects(c.commitWarehouseTransferReceipt(f.id),/reply lost/);assert.equal(f.storage.size,1);
 const resumed=f.open();assert.equal(resumed.pendingMainTransferPhysicalOperations()[0].action,'RECEIVE');
 const result=await resumed.commitWarehouseTransferReceipt(f.id);assert.equal(result.physicalReceiptOnly,true);assert.equal(result.allocationCompleted,false);
 assert.deepEqual(f.calls[1],f.calls[2]);assert.equal(f.storage.size,0);
 f.getTransfer().allocationCompleted=true;
 const confirmed=await resumed.commitWarehouseTransferReceipt(f.id);assert.deepEqual(f.calls[2],f.calls[3]);assert.equal(confirmed.physicalReceiptOnly,true);
});
test('disabled gates, identity/project changes and wrong replies keep checkpoints without legacy fallback',async()=>{
 for(const mode of ['flag','role','project','reply','read']){
  const f=fixture(),c=f.open();if(mode==='reply')f.setBad(true);else if(mode==='read')f.setFailRead(true);
  else f.setAfter(ctx=>{if(mode==='flag')ctx.YUSHIN_PREVIEW_MAIN_TRANSFER_DISPATCH=false;if(mode==='role')ctx.currentUserRole='admin';if(mode==='project')ctx.db.app.options.projectId='yu-shing-company';});
  await assert.rejects(c.commitWarehouseTransfer({id:f.id,requestId:f.requestId,qty:3}));assert.equal(f.storage.size,1);assert.equal(f.calls.length,1);
 }
 const f=fixture(),c=f.open();f.setLose(true);await assert.rejects(c.commitWarehouseTransfer({id:f.id,requestId:f.requestId,qty:3}));
 const resumed=f.open();resumed.YUSHIN_PREVIEW_MAIN_TRANSFER_DISPATCH=false;
 await assert.rejects(resumed.commitMainTransferPhysicalBackend('DISPATCH',f.id),/旗標/);assert.equal(resumed.pendingMainTransferPhysicalOperations().length,1);
 assert.equal(f.calls.length,1);assert.equal(f.storage.size,1);
});
test('receipt cannot consume an unconfirmed dispatch and SDK loader refuses account switches',async()=>{
 const f=fixture(),c=f.open();f.setLose(true);await assert.rejects(c.commitWarehouseTransfer({id:f.id,requestId:f.requestId,qty:3}));
 await assert.rejects(c.commitWarehouseTransferReceipt(f.id),/原寄出/);assert.equal(f.calls.length,1);
 const g=fixture(),d=g.open();d.ensureReservationFunctionsCompat=async()=>{d.currentUser={uid:'X'};};
 await assert.rejects(d.commitWarehouseTransfer({id:g.id,requestId:g.requestId,qty:3}),/載入後端期間/);assert.equal(g.calls.length,0);assert.equal(g.storage.size,0);
});
test('changed source, malformed storage and corrupted receipt witness cannot clear or overwrite original intent',async()=>{
 const f=fixture(),c=f.open();f.setLose(true);await assert.rejects(c.commitWarehouseTransfer({id:f.id,requestId:f.requestId,qty:3}));
 await assert.rejects(c.commitMainTransferPhysicalBackend('DISPATCH',f.id,{id:f.id,requestId:'changed'}),/原操作/);assert.equal(f.calls.length,1);
 const key=[...f.storage.keys()][0],raw=f.storage.get(key);f.storage.set(key,'{bad');
 assert.ok(c.pendingMainTransferPhysicalOperations()[0].error);await assert.rejects(c.commitMainTransferPhysicalBackend('DISPATCH',f.id));assert.equal(f.storage.get(key),'{bad');
 f.storage.set(key,raw);await c.commitMainTransferPhysicalBackend('DISPATCH',f.id);
 f.setAfter(()=>{f.getTransfer().receiptIntentHash='';});await assert.rejects(c.commitWarehouseTransferReceipt(f.id),/憑證/);assert.equal(f.storage.size,1);
});
test('legacy receipt refuses backend-owned transfers even outside Preview when all flags are off',async()=>{
 const source=fs.readFileSync('src/services/warehouse-transfer.js','utf8');
 const c=vm.createContext({currentUser:{uid:'U'},currentUserRole:'warehouse',canReceiveInventoryCapability:()=>true,canAccessPage:()=>true,deliveryActor:()=> 'U',
  db:{collection:n=>({doc:id=>({path:n+'/'+id})})},runRoleTransaction:async fn=>fn({get:async()=>({exists:true,data:()=>({dispatchIntentHash:'hash',status:'RECEIVED'})})})});
 vm.runInContext(source,c);await assert.rejects(c.commitWarehouseTransferReceipt('transfer_12345678'),/禁止使用舊收貨/);
});

test('concurrent receipt preflights reuse the first frozen operation instead of overwriting it',async()=>{
 const f=fixture(),c=f.open();await c.commitWarehouseTransfer({id:f.id,requestId:f.requestId,qty:3});
 let serial=0;c.lifecycleRecordId=()=> 'receipt_parallel_'+(++serial);
 await Promise.all([c.commitWarehouseTransferReceipt(f.id),c.commitWarehouseTransferReceipt(f.id)]);
 const receipts=f.calls.filter(row=>row.name==='receiveV2MainTransfer');assert.equal(receipts.length,1);
 assert.equal(f.storage.size,0);
});
test('recovery rows remain visible after source leaves operational queries and flags are disabled',()=>{
 const rows=[{action:'DISPATCH',id:'transfer_12345678',requestId:'request_12345678'},{action:'RECEIVE',id:'transfer_87654321'}];
 const table={},elements={mainTransferRequestPanel:{},mainTransferRequestBody:{closest:()=>table},mainTransferRequestStatus:{},
  inventoryTransferReceivingBody:{},inventoryTransferReceivingStatus:{},inventoryTransferReceivingTab:{}};
 const c=vm.createContext({document:{getElementById:id=>elements[id]},currentUser:{uid:'U'},currentUserRole:'warehouse',warehouseMasterCache:[],orderWorkQueueCache:[],
  canReceiveInventoryCapability:()=>true,canAccessPage:()=>true,canManageInventoryStockPolicy:()=>false,canEditPage:()=>false,
  normalizedOrderStatus:()=> 'normal',orderInventorySyncIncomplete:()=>false,normalizedOrderItems:()=>[],itemDispatchState:()=>({}),
  defaultWarehouse:()=>({id:'MAIN'}),pendingMainTransferPhysicalOperations:()=>rows,escapeHtml:String,inlineJsValue:JSON.stringify,
  YUSHIN_PREVIEW_MAIN_TRANSFER_DISPATCH:false,YUSHIN_PREVIEW_MAIN_TRANSFER_RECEIPT:false});
 for(const path of ['modules/warehouse-logistics.js','modules/main-warehouse-transfers.js'])vm.runInContext(fs.readFileSync(path,'utf8'),c);
 c.renderMainTransferRequests();c.renderWarehouseTransfers();
 assert.match(elements.mainTransferRequestBody.innerHTML,/確認前次寄出結果/);assert.match(elements.mainTransferRequestBody.innerHTML,/transfer_12345678/);
 assert.match(elements.inventoryTransferReceivingBody.innerHTML,/確認前次入庫結果/);assert.match(elements.inventoryTransferReceivingBody.innerHTML,/transfer_87654321/);
 assert.equal(table.hidden,false);
});
