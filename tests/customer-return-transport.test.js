'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const core=require('../modules/fulfillment-core');
const source=fs.readFileSync('src/services/customer-return-transport.js','utf8');
function fixture(){
 const intent={orderId:'O',itemId:'I',shipmentId:'S',syncAttemptId:'sync',selections:[{lotId:'L',qty:1}],operationId:'return_receipt_001',warehouseId:'A',date:'2026-10-21',reason:'訂錯貨',condition:'RESTOCKABLE',settlement:'CLOSE',requestId:'Q'};
 const order={inventoryReservationStatus:'completed',inventoryReservationAttemptId:'sync',warehouseShipmentRecords:[{id:'S',itemId:'I',warehouseId:'A'}],returnRequests:[{id:'Q',itemId:'I',qty:1,receivedQty:0,status:'PENDING'}],returnRecords:[]};
 const storage=new Map(),calls=[];let proof,failSave=false,afterRead=()=>{},transport;
 const applied=p=>{
  const record={...p,id:p.operationId,qty:1,lotAllocations:p.selections,createdByUid:'U',createdByRole:'warehouse',movementId:'location-return-'+p.operationId,intentHash:'hash'};
  delete record.selections;delete record.operationId;delete record.syncAttemptId;
  if(!proof){proof={orderId:'O',requestId:'Q',itemId:'I',warehouseId:'A',qty:1,receivedBy:'U',receivedByRole:'warehouse',quality:'SALEABLE',disposition:'STOCK',movementId:record.movementId,intentHash:'hash',record};order.returnRecords.push(record);Object.assign(order.returnRequests[0],{receivedQty:1,status:'RECEIVED'});}
  return {data:{status:'applied',orderId:'O',itemId:'I',shipmentId:'S',warehouseId:'A',requestId:'Q',receiptId:p.operationId,movementId:record.movementId,qty:1,settlement:'CLOSE'}};
 };transport=applied;
 const open=()=>{
  const functions={app:{options:{projectId:'demo-yushin'}},useEmulator:(h,p)=>{assert.equal(h,'127.0.0.1');assert.equal(p,5001);},httpsCallable:name=>async p=>{assert.equal(name,'receiveV2CustomerReturn');calls.push(structuredClone(p));return transport(p,c);}};
  const c=vm.createContext({YushinFulfillment:core,YUSHIN_V2_RETURN_RECEIPT_EMULATOR:true,location:{hostname:'localhost'},currentUser:{uid:'U'},currentUserRole:'warehouse',canReceiveInventoryCapability:()=>true,
   firebase:{functions:()=>{throw Error('global API forbidden');},app:()=>({functions:region=>{assert.equal(region,'asia-east1');return functions;}}),auth:()=>({app:{options:{projectId:'demo-yushin'}},currentUser:{uid:'U'},emulatorConfig:{host:'localhost',port:9099}})},
   sessionStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>{if(failSave)throw Error('storage failed');storage.set(k,v);},removeItem:k=>storage.delete(k)},
   db:{collection:n=>({doc:id=>({get:async options=>{assert.equal(options.source,'server');afterRead(c,n);const value=n==='orders'?order:proof;return {exists:!!value,data:()=>structuredClone(value)};}})})}});
  vm.runInContext(source,c);return c;
 };
 return {intent,order,storage,calls,open,applied,getProof:()=>proof,setTransport:f=>transport=f,setSaveFailure:v=>failSave=v,setAfterRead:f=>afterRead=f};
}
test('return receipt freezes complete intent before transmission and reload retries original ID after successful lost reply',async()=>{
 const f=fixture();f.setTransport(p=>{f.applied(p);throw Error('lost reply');});
 await assert.rejects(f.open().receiveV2CustomerReturnEmulator('O',f.intent),/lost reply/);
 assert.equal(f.storage.size,1);assert.equal(f.order.returnRequests[0].status,'RECEIVED');
 f.setTransport(p=>({data:{...f.applied(p).data,status:'already-applied'}}));
 const saved=await f.open().receiveV2CustomerReturnEmulator('O');
 assert.deepEqual(f.calls[0],f.calls[1]);assert.equal(f.calls[0].actorUid,undefined);assert.equal(f.calls[0].actorRole,undefined);
 assert.equal(f.order.returnRecords.length,1);assert.equal(saved.id,'O');assert.equal(f.storage.size,0);
});
test('return receipt blocks changed pending source quantity reason date operation and current actor without another call',async()=>{
 const f=fixture();f.setTransport(()=>{throw Error('unknown');});const c=f.open();await assert.rejects(c.receiveV2CustomerReturnEmulator('O',f.intent));
 for(const patch of [{requestId:'other'},{shipmentId:'other'},{warehouseId:'B'},{selections:[{lotId:'L',qty:2}]},{reason:'other'},{date:'2026-10-22'},{operationId:'return_receipt_002'}])
  await assert.rejects(c.receiveV2CustomerReturnEmulator('O',{...f.intent,...patch}),/未確認/);
 c.currentUserRole='admin';await assert.rejects(c.receiveV2CustomerReturnEmulator('O'),/原帳號與角色/);
 assert.equal(f.calls.length,1);assert.equal(f.storage.size,1);
});
test('return receipt fails closed on wrong environment persistence invalid dates missing request and stale original source',async()=>{
 for(const mode of ['host','project','auth','role','flag','storage','date','request','source','sync','read-actor']){
  const f=fixture(),c=f.open(),intent={...f.intent};
  if(mode==='host')c.location.hostname='production.example';
  if(mode==='project')c.firebase.auth=()=>({app:{options:{projectId:'production'}},emulatorConfig:{host:'localhost',port:9099}});
  if(mode==='auth')c.currentUser={uid:'other'};
  if(mode==='role')c.currentUserRole='sales';
  if(mode==='flag')c.YUSHIN_V2_RETURN_RECEIPT_EMULATOR=false;
  if(mode==='storage')f.setSaveFailure(true);
  if(mode==='date')intent.date='2026-02-30';
  if(mode==='request')delete intent.requestId;
  if(mode==='source')f.order.warehouseShipmentRecords=[];
  if(mode==='sync')intent.syncAttemptId='stale';
  if(mode==='read-actor')f.setAfterRead(ctx=>ctx.currentUser={uid:'other'});
  await assert.rejects(c.receiveV2CustomerReturnEmulator('O',intent),undefined,mode);assert.equal(f.calls.length,0,mode);
 }
});
test('return receipt preserves checkpoint on corrupt cache bad reply failed readback and inconsistent receipt/order evidence',async()=>{
 for(const mode of ['cache','reply','read','receipt','record','actor','request']){
  const f=fixture(),c=f.open();
  if(mode==='cache')f.storage.set('v2-return-receipt:U:O','broken');
  f.setTransport((p,ctx)=>{const reply=f.applied(p);
   if(mode==='reply')reply.data.movementId='wrong';
   if(mode==='read')f.setAfterRead(()=>{throw Error('server unavailable');});
   if(mode==='receipt')f.getProof().receivedBy='other';
   if(mode==='record')f.order.returnRecords=[];
   if(mode==='actor')ctx.currentUserRole='admin';
   if(mode==='request')f.order.returnRequests=[];
   return reply;
  });
  await assert.rejects(c.receiveV2CustomerReturnEmulator('O',f.intent));assert.equal(f.storage.size,1,mode);
 }
});
test('return receipt refuses concurrent different intents before a second transmission and tolerates same intent confirmation',async()=>{
 const f=fixture(),c=f.open();
 const attempts=await Promise.allSettled([c.receiveV2CustomerReturnEmulator('O',f.intent),c.receiveV2CustomerReturnEmulator('O',{...f.intent,operationId:'return_receipt_other'})]);
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal(f.calls.length,1);assert.equal(f.storage.size,0);
 const g=fixture(),d=g.open();await Promise.all([d.receiveV2CustomerReturnEmulator('O',g.intent),d.receiveV2CustomerReturnEmulator('O',g.intent)]);
 assert.equal(g.order.returnRecords.length,1);assert.equal(g.storage.size,0);
});
