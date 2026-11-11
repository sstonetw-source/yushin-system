'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const production=fs.readFileSync('src/infrastructure/production-transaction.js','utf8');
const transport=fs.readFileSync('src/services/supply-cancellation-transport.js','utf8');
const service=fs.readFileSync('src/services/supply-order.js','utf8');
const id='supplier-stop-20261110-001';
function fixture({whole=false,lostReply=false,priorCancelled=false}={}){
 const rows=new Map(),pending=new Map(),calls=[],invalidated=[];
 const ids=whole?['S1','S2']:['S1'];
 rows.set('purchaseOrders/PO',{poNo:'PO',status:'ORDERED',supplyOrderIds:ids});
 ids.forEach((s,i)=>rows.set('supplyOrders/'+s,{purchaseDocumentId:'PO',productKey:'P'+i,
  warehouseId:'W',fulfillmentType:'WAREHOUSE',demandId:'D'+i,orderId:'O'+i,
  qty:5,receivedQty:2,incomingRegisteredQty:3,status:'PARTIAL_RECEIPT'}));
 if(whole&&priorCancelled)Object.assign(rows.get('supplyOrders/S1'),{status:'CLOSED',
  incomingRegisteredQty:0,closedQty:3,cancellationOperationId:'previous-single-20261111-01'});
 let first=true;
 const app={options:{projectId:'yu-shing-company'},functions:()=>functions};
 const functions={app,httpsCallable(name){return async payload=>{
  calls.push({name,payload:structuredClone(payload)});
  for(const s of ids){if(priorCancelled&&s==='S1')continue;const row=rows.get('supplyOrders/'+s);
   Object.assign(row,{status:'CLOSED',incomingRegisteredQty:0,closedQty:3,cancellationOperationId:payload.operationId});}
  if(whole)Object.assign(rows.get('purchaseOrders/PO'),{status:'CLOSED',stoppedQty:6,
   closedQty:6,cancellationOperationId:payload.operationId,updatedAt:'now'});
  if(lostReply&&first){first=false;throw Error('response lost');}
  return {data:{status:first?'applied':'already-applied',operationId:payload.operationId,
   poId:payload.poId,actorUid:'buyer',actorRole:'purchaser',supplyIds:ids,
   cancelledQty:3*(ids.length-(priorCancelled?1:0)),
   affectedOrderIds:ids.map((_,i)=>'O'+i)}};
 }}};
 const auth={app,currentUser:{uid:'buyer'},emulatorConfig:null};
 const c=vm.createContext({APP_ENVIRONMENT:'production',currentUser:{uid:'buyer'},currentUserRole:'purchaser',
  location:new URL('https://sstonetw-source.github.io/yushin-system/'),
  YUSHIN_PRODUCTION_SUPPLY_CANCELLATION_BACKEND:true,
  YUSHIN_PRODUCTION_SUPPLY_CANCELLATION_LEGACY_BLOCKED:true,
  canCreatePurchaseOrderCapability:()=>true,canAccessPage:()=>true,
  lifecycleRecordId:()=>id,sessionStorage:{getItem:k=>pending.has(k)?pending.get(k):null,
   setItem:(k,v)=>pending.set(k,v),removeItem:k=>pending.delete(k)},
  firebase:{app:()=>app,auth:()=>auth,functions:()=>functions},
  db:{app,collection:name=>({doc:key=>({async get(options){assert.equal(options.source,'server');
   return {exists:rows.has(name+'/'+key),data:()=>structuredClone(rows.get(name+'/'+key))};}})})},
  invalidateWarehouseStockCache:(...v)=>invalidated.push(v),invalidateProcurementDemandQueue:()=>{}});
 vm.runInContext(production+transport+service,c);
 return {c,rows,pending,calls,invalidated};
}
test('production supply cancellation remains disabled unless both approved gates are true',async()=>{
 for(const flag of ['YUSHIN_PRODUCTION_SUPPLY_CANCELLATION_BACKEND','YUSHIN_PRODUCTION_SUPPLY_CANCELLATION_LEGACY_BLOCKED']){
  const f=fixture();f.c[flag]=false;
  await assert.rejects(f.c.cancelOutstandingSupplyRecord('PO','S1','Stopped'),/可信任後端/);
  await assert.rejects(f.c.stopPurchaseOrderOutstanding('PO','Stopped'),/可信任後端/);
  assert.equal(f.calls.length,0);assert.equal(f.pending.size,0);
 }
});
test('single supply uses backend, confirms server source and never writes from browser',async()=>{
 const f=fixture();const r=await f.c.cancelOutstandingSupplyRecord('PO','S1','Stopped',{
  onStockCommitted:(...v)=>f.invalidated.push(v),onDemandChanged:()=>{}});
 assert.equal(r.cancelledQty,3);assert.equal(r.terminalStatus,'CLOSED');assert.equal(r.orderId,'O0');
 assert.equal(f.calls[0].name,'cancelV2OutstandingSupply');
 assert.equal(f.calls[0].payload.operationId,id);assert.equal(f.calls[0].payload.supplyId,'S1');
 assert.equal(f.invalidated.length,1);assert.equal(f.pending.size,0);
});
test('whole PO uses a single atomic backend request and verifies closed PO',async()=>{
 const f=fixture({whole:true});const r=await f.c.stopPurchaseOrderOutstanding('PO','Stopped');
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].name,'stopV2PurchaseOrderOutstanding');
 assert.equal(Object.prototype.hasOwnProperty.call(f.calls[0].payload,'supplyId'),false);
 assert.equal(r.cancelledQty,6);assert.equal(r.patch.status,'CLOSED');assert.equal(f.pending.size,0);
});
test('whole PO verifies previously cancelled lines against the total stopped quantity',async()=>{
 const f=fixture({whole:true,priorCancelled:true});
 const r=await f.c.stopPurchaseOrderOutstanding('PO','Stopped');
 assert.equal(r.cancelledQty,3);
 assert.equal(r.patch.stoppedQty,6);
 assert.equal(f.rows.get('supplyOrders/S1').cancellationOperationId,'previous-single-20261111-01');
 assert.equal(f.rows.get('supplyOrders/S2').cancellationOperationId,id);
 assert.equal(f.pending.size,0);
});
test('lost Callable response reuses exact original ID even after source became terminal',async()=>{
 const f=fixture({lostReply:true});
 await assert.rejects(f.c.cancelOutstandingSupplyRecord('PO','S1','Stopped'),/response lost/);
 assert.equal(f.pending.size,1);
 await assert.rejects(f.c.cancelOutstandingSupplyRecord('PO','S1','Changed reason'),/原取消原因/);
 const prior=f.c.pendingSupplyCancellation('PO','S1',false);
 assert.equal(prior.payload.operationId,id);
 const r=await f.c.cancelOutstandingSupplyRecord('PO','S1','Stopped');
 assert.equal(r.cancelledQty,3);assert.equal(f.pending.size,0);
 assert.deepEqual(f.calls.map(x=>x.payload.operationId),[id,id]);
});
test('project, site, role and live receipt inconsistencies all fail closed',async()=>{
 for(const change of [
  f=>f.c.location=new URL('https://other.github.io/yushin-system/'),
  f=>f.c.db.app.options.projectId='preview-20135',
  f=>f.c.currentUserRole='sales',
  f=>{const old=f.c.firebase.app;f.c.firebase.app=()=>({...old(),options:{projectId:'demo-yushin'}});},
 ]){
  const f=fixture();change(f);
  await assert.rejects(f.c.cancelOutstandingSupplyRecord('PO','S1','Stopped'));
  assert.equal(f.calls.length,0);
 }
 const f=fixture();f.rows.get('supplyOrders/S1').qty=10;
 // Backend fixture commits only 3, so the server receipt must refuse to clear the checkpoint.
 await assert.rejects(f.c.cancelOutstandingSupplyRecord('PO','S1','Stopped'),/取消量.*不一致/);
 assert.equal(f.pending.size,1);
});
test('pending malformed session checkpoint is never silently replaced',async()=>{
 const f=fixture(),key=f.c.supplyCancellationPendingKey('PO','S1',false);
 f.pending.set(key,'{"bad":"data"}');
 await assert.rejects(f.c.cancelOutstandingSupplyRecord('PO','S1','Stopped'),/暫存內容不一致/);
 assert.equal(f.calls.length,0);assert.equal(f.pending.size,1);
});
test('UI explicitly resumes a pending operation before terminal-state early returns',()=>{
 const ui=fs.readFileSync('src/features/purchasing/purchase-cancellation-workspace.js','utf8');
 assert.match(ui,/pendingSupplyCancellation\(poId,supply\.id,false\)/);
 assert.match(ui,/pendingSupplyCancellation\(poId,'',true\)/);
 assert.match(ui,/!pending&&isPurchaseTerminalStatus\(supply\.status\)/);
 assert.match(ui,/!pending&&isPurchaseTerminalStatus\(po\.status\)/);
 assert.match(ui,/stopCommitted\|\|err\?\.supplyCommitted/);
});
