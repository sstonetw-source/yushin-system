'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
function fixture(){const storage=new Map(),calls=[];let lost=false,transfer=null;
 const input={id:'T',orderId:'O',itemId:'I',fromWarehouseId:'A',toWarehouseId:'B',qty:3,expectedPlan:{mode:'TRANSFER',contact:'W',phone:'123',address:'Taipei',warehouseId:'B',packages:1,notes:''}};
 function open(){const c=vm.createContext({currentUser:{uid:'U'},currentUserRole:'warehouse',YUSHIN_ORDER_TRANSFER_HANDOFF_EMULATOR:true,YUSHIN_ORDER_TRANSFER_DISPATCH_EMULATOR:true,YUSHIN_ORDER_TRANSFER_RECEIVE_EMULATOR:true,lifecycleRecordId:()=> 'receipt_12345678',canReceiveInventoryCapability:()=>true,canAccessPage:()=>true,location:{hostname:'localhost'},sessionStorage:{get length(){return storage.size;},key:n=>[...storage.keys()][n],getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},db:{collection:()=>({doc:()=>({get:async()=>({exists:!!transfer,data:()=>structuredClone(transfer)})})})}});
 const functions={useEmulator(){},httpsCallable:name=>async payload=>{calls.push({name,payload:structuredClone(payload)});const action=name==='handoffOrderTransfer'?'HANDOFF':name==='dispatchOrderTransfer'?'DISPATCH':'RECEIVE';if(action!=='RECEIVE')transfer={...payload,kind:action==='HANDOFF'?'HANDOFF':'TRANSFER',status:action==='HANDOFF'?'RECEIVED':'IN_TRANSIT',...(action==='HANDOFF'?{ownerUid:'S',receivedByUid:'U',receivedByRole:'warehouse'}:{}),orderTransferIntentHash:'hash',deliveryPlan:payload.expectedPlan,createdByUid:'U',createdByRole:'warehouse'};else Object.assign(transfer,{status:'RECEIVED',receiptOperationId:payload.operationId,receivedByUid:'U',receivedByRole:'warehouse'});if(lost){lost=false;throw Error('reply lost');}return {data:{action,id:payload.id,operationId:action!=='RECEIVE'?payload.id:payload.operationId,status:'applied',actorUid:'U',actorRole:'warehouse'}};}};
 c.mainTransferBackendContext=({emulatorFlag})=>({project:'demo-yushin',functions,check(){if(c.currentUser?.uid!=='U'||c.currentUserRole!=='warehouse'||c[emulatorFlag]!==true)throw Error('context changed');}});
 vm.runInContext(fs.readFileSync('src/services/order-transfer-transport.js','utf8'),c);return c;}
 return {input,open,storage,calls,lose:()=>lost=true};}
test('dispatch lost reply refresh retains original payload and forbids another ID for same item',async()=>{const f=fixture();f.lose();await assert.rejects(f.open().commitOrderTransferBackend('DISPATCH','T',f.input),/reply lost/);const c=f.open();assert.equal(c.pendingOrderTransferOperations()[0].id,'T');await assert.rejects(c.commitOrderTransferBackend('DISPATCH','OTHER',{...f.input,id:'OTHER'}),/原操作編號/);await c.commitOrderTransferBackend('DISPATCH','T');assert.deepEqual(f.calls[0],f.calls[1]);assert.equal(f.storage.size,0);});
test('receipt lost reply refresh confirms same ID without a second physical receipt',async()=>{const f=fixture(),c=f.open();await c.commitOrderTransferBackend('DISPATCH','T',f.input);f.lose();await assert.rejects(c.commitOrderTransferBackend('RECEIVE','T'));await f.open().commitOrderTransferBackend('RECEIVE','T');assert.deepEqual(f.calls[1],f.calls[2]);assert.equal(f.storage.size,0);});
test('disabled flag malformed storage and account change retain checkpoints and make no new calls',async()=>{const f=fixture();f.lose();await assert.rejects(f.open().commitOrderTransferBackend('DISPATCH','T',f.input));const c=f.open();c.YUSHIN_ORDER_TRANSFER_DISPATCH_EMULATOR=false;await assert.rejects(c.commitOrderTransferBackend('DISPATCH','T'));assert.equal(f.calls.length,1);const key=[...f.storage.keys()][0];f.storage.set(key,'bad');assert.ok(f.open().pendingOrderTransferOperations()[0].error);await assert.rejects(f.open().commitOrderTransferBackend('DISPATCH','T'));assert.equal(f.storage.get(key),'bad');const g=fixture(),d=g.open();d.ensureReservationFunctionsCompat=async()=>{d.currentUser={uid:'OTHER'};};await assert.rejects(d.commitOrderTransferBackend('DISPATCH','T',g.input));assert.equal(g.calls.length,0);});
test('simultaneous original clicks share one callable and receipt waits for unconfirmed dispatch',async()=>{const f=fixture(),c=f.open();await Promise.all([c.commitOrderTransferBackend('DISPATCH','T',f.input),c.commitOrderTransferBackend('DISPATCH','T',f.input)]);assert.equal(f.calls.length,1);const g=fixture();g.lose();await assert.rejects(g.open().commitOrderTransferBackend('DISPATCH','T',g.input));await assert.rejects(g.open().commitOrderTransferBackend('RECEIVE','T'),/寄出/);assert.equal(g.calls.length,1);});

test('handoff freezes owner destination across lost reply and reload; duplicate and conflicting actions cannot move twice',async()=>{
 const f=fixture(),input={...f.input,toWarehouseId:'custody-S'};f.lose();
 const c=f.open();await assert.rejects(c.commitOrderTransferBackend('HANDOFF','T',input),/reply lost/);
 assert.equal(c.pendingOrderTransferOperations()[0].action,'HANDOFF');
 await assert.rejects(c.commitOrderTransferBackend('HANDOFF','OTHER',{...input,id:'OTHER'}),/原操作編號/);
 await assert.rejects(c.commitOrderTransferBackend('DISPATCH','OTHER',{...f.input,id:'OTHER'}),/原操作編號/);
 await assert.rejects(c.commitOrderTransferBackend('HANDOFF','T',{...input,toWarehouseId:'custody-X'}),/不可修改/);
 const d=f.open();d.YUSHIN_ORDER_TRANSFER_HANDOFF_EMULATOR=false;
 await assert.rejects(d.commitOrderTransferBackend('HANDOFF','T'),/禁止回退/);assert.equal(f.calls.length,1);
 const e=f.open();await Promise.all([e.commitOrderTransferBackend('HANDOFF','T'),e.commitOrderTransferBackend('HANDOFF','T')]);
 assert.equal(f.calls.length,2);assert.deepEqual(f.calls[0],f.calls[1]);assert.equal(f.calls[0].name,'handoffOrderTransfer');assert.equal(f.storage.size,0);
 await assert.rejects(e.commitOrderTransferBackend('RECEIVE','T'),/找不到/);
});
test('handoff cannot clear checkpoint when server proof differs',async()=>{
 const f=fixture(),c=f.open();await assert.rejects(c.commitOrderTransferBackend('HANDOFF','T',{...f.input,toWarehouseId:'custody-X'}),/憑證/);
 assert.equal(f.storage.size,1);
});
