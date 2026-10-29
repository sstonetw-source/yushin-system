'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('src/services/custody-return.js','utf8');
function fixture(){
 const uid='SALES',orderId='ORDER',itemId='I',custody='custody-SALES';
 const lotId='TRANSFER-0',shipmentId='custody_ship_ui_123456',storage=new Map(),requests=[];
 let lost=false,writes=0;
 const order={status:'active',orderStatus:'normal',ownerUid:uid,salesCode:'S01',
  inventoryReservationStatus:'completed',inventoryReservationAttemptId:'sync_123456789',
  returnPending:false,returnRequests:[],returnRecords:[],
  items:[{itemId,warehouseId:custody,custodyTransferId:'TRANSFER'}],
  warehouseShipmentRecords:[{id:shipmentId,itemId,warehouseId:custody,custodyTransferId:'TRANSFER',
   lotAllocations:[{lotId,lotNo:'BATCH-001',qty:2}]}],
  deliveryRecords:[{id:'confirm_ui_123456',shipmentId,qty:2}]};
 const appOptions={projectId:'demo-yushin'};
 const auth={app:{options:appOptions},emulatorConfig:{host:'127.0.0.1',port:9099},currentUser:{uid}};
 const functions={app:{options:appOptions},useEmulator(host,port){assert.equal(host,'127.0.0.1');assert.equal(port,5001);},
  httpsCallable(name){assert.equal(name,'receiveV3CustodyReturn');return async intent=>{
   requests.push(structuredClone(intent));
   if(!order.returnRecords.find(row=>row.id===intent.operationId)){
    writes++;
    order.returnRecords.push({id:intent.operationId,itemId,shipmentId,warehouseId:custody,
     qty:intent.selections[0].qty,settlement:'CLOSE',condition:'RESTOCKABLE',date:intent.date,
     reason:intent.reason,movementId:'location-return-'+intent.operationId,
     lotAllocations:structuredClone(intent.selections)});
   }
   if(lost){lost=false;throw Error('lost response');}
   return{data:{status:requests.length===1?'applied':'already-applied',orderId,itemId,
    shipmentId,warehouseId:custody,qty:intent.selections[0].qty,
    movementId:'location-return-'+intent.operationId}};
  };}};
 const db={app:{options:appOptions},collection(name){return{doc(id){return{
  async get(){if(name==='orders')return{exists:true,data:()=>structuredClone(order)};
   if(name==='inventoryReservations')return{exists:true,data:()=>({locationSchemaVersion:3,custodyTransferId:'TRANSFER'})};
   throw Error('Unexpected '+name+'/'+id);}
 };}};}};
 const open=(mod={})=>{
  const ctx={window:{},globalThis:null,currentUser:{uid},currentUserRole:'sales',
   firebase:{auth:()=>auth,functions:()=>functions,app:()=>({options:appOptions,functions:()=>functions})},
   db,sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),
    removeItem:key=>storage.delete(key)},location:{hostname:'localhost'},
   canManageOrderLifecycleCapability:()=>true,canEditPage:()=>true,...mod};
  ctx.globalThis=ctx;vm.createContext(ctx);vm.runInContext(source,ctx);
  return ctx;
 };
 const input=(operationId,qty=1)=>({orderId,itemId,shipmentId,lotId,qty,
  date:'2026-10-30',reason:'已收回原批次',operationId});
 return{open,input,storage,requests,order,loseOnce(){lost=true;},writes:()=>writes};
}
test('V3 Custody return UI freezes the original lot, operator and intent across lost reply and refresh',async()=>{
 const f=fixture(),app=f.open({YUSHIN_V3_CUSTODY_RETURN_EMULATOR:true});
 assert.equal(app.v3CustodyReturnCandidates(f.order).length,1);
 f.loseOnce();await assert.rejects(app.commitV3CustodyReturn(f.input('custody_return_ui_123456')),/lost response/);
 assert.equal(f.writes(),1);assert.equal(f.storage.size,1);
 await assert.rejects(app.commitV3CustodyReturn(f.input('custody_return_ui_other')),/原操作編號/);
 assert.equal(f.writes(),1);
 const reloaded=f.open({YUSHIN_V3_CUSTODY_RETURN_EMULATOR:true});
 assert.equal((await reloaded.window.resumeV3CustodyReturn('ORDER','I')).returnRecords.length,1);
 assert.equal(f.writes(),1);assert.equal(f.storage.size,0);
 assert.equal(f.requests[0].operationId,f.requests[1].operationId);
 assert.deepEqual(f.requests[0].selections,[{lotId:'TRANSFER-0',qty:1}]);
 assert.equal(f.requests[0].settlement,'CLOSE');
});
test('V3 Custody return is closed outside demo, changed login, and restricted roles',async()=>{
 const f=fixture(),intent=f.input('custody_return_ui_block');
 for(const mod of [{},{YUSHIN_V3_CUSTODY_RETURN_EMULATOR:true,location:{hostname:'production.example'}},
  {YUSHIN_V3_CUSTODY_RETURN_EMULATOR:true,currentUserRole:'warehouse'}]){
  const app=f.open(mod);await assert.rejects(app.commitV3CustodyReturn(intent));
  assert.equal(f.requests.length,0);
 }
 await assert.rejects(f.open({YUSHIN_V3_CUSTODY_RETURN_EMULATOR:true})
  .commitV3CustodyReturn({...intent,qty:3}),/原批次/);
 assert.equal(f.storage.size,0);
});
test('original order page separates Custody return receipt from generic client-side stock change',()=>{
 const order=fs.readFileSync('src/features/orders/order-workspace.js','utf8');
 const build=fs.readFileSync('tools/build-app.cjs','utf8');
 assert.match(order,/openV3CustodyReturn/);
 assert.match(order,/YUSHIN_V3_CUSTODY_RETURN_EMULATOR/);
 assert.match(build,/src\/services\/custody-return.js/);
 assert.match(source,/receiveV3CustodyReturn/);
 assert.doesNotMatch(source,/runRoleTransaction|transaction\.update\(|transaction\.set\(/);
});
