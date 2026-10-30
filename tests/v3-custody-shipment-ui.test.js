'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('src/services/custody-shipment.js','utf8');
function fixture({multi=false}={}){
 const uid='SALES',orderId='ORDER',itemId='I',custody='custody-SALES';
 const storage=new Map(),requests=[];
 let throwsLost=false,writes=0;
 const plan={mode:'CUSTOMER_SHIP',contact:'Contact',phone:'0222222222',address:'Address',
  warehouseId:'',packages:1,notes:''};
 const order={ownerUid:uid,inventoryReservationStatus:'completed',inventoryReservationAttemptId:'sync_123456789',
  items:[{itemId,warehouseId:custody,custodyTransferId:'TRANSFER',reservedQty:2},
   ...(multi?[{itemId:'J',warehouseId:custody,custodyTransferId:'TRANSFER-J',reservedQty:2}]:[])],
  warehouseShipmentRecords:[]};
 const firebaseOptions={projectId:'demo-yushin'};
 const auth={app:{options:firebaseOptions},emulatorConfig:{host:'127.0.0.1',port:9099},currentUser:{uid}};
 const functions={app:{options:firebaseOptions},useEmulator(host,port){assert.equal(host,'127.0.0.1');assert.equal(port,5001);},
  httpsCallable(name){assert.equal(name,'shipV3CustodyItem');return async request=>{
   requests.push(structuredClone(request));
   let existing=order.warehouseShipmentRecords.find(row=>row.id===request.operationId);
   if(!existing){writes++;
    existing={id:request.operationId,itemId:request.itemId,warehouseId:custody,qty:request.quantity,date:request.date,
     notes:request.notes,custodyTransferId:order.items.find(row=>row.itemId===request.itemId)?.custodyTransferId,
     movementId:'location-ship-'+request.operationId,
     deliveryPlan:request.expectedPlan};
    order.warehouseShipmentRecords.push(existing);
   }
   if(throwsLost){throwsLost=false;throw Error('lost reply');}
   return{data:{status:writes===requests.length?'applied':'already-applied',orderId,itemId:request.itemId,
    warehouseId:custody,qty:request.quantity,movementId:'location-ship-'+request.operationId}};
  };}};
 const db={app:{options:firebaseOptions},collection(name){return{doc(id){return{
  async get(){if(name==='orders')return{exists:true,data:()=>structuredClone(order)};
   if(name==='inventoryReservations')return{exists:true,data:()=>({locationSchemaVersion:3,
    custodyTransferId:id.endsWith('__J')?'TRANSFER-J':'TRANSFER'})};
   throw Error('unexpected read '+name+'/'+id);}
 };}};}};
 const options={uuid:'uuid'};
 const open=(mod={})=>{
  const ctx={window:{},globalThis:null,currentUser:{uid},currentUserRole:'sales',
   firebase:{auth:()=>auth,functions:()=>functions,app:()=>({options:firebaseOptions,functions:()=>functions})},
   db,sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),
    removeItem:key=>storage.delete(key)},
   location:{hostname:'localhost'},
   canManageOrderLifecycleCapability:()=>true,canEditPage:()=>true,
   YushinWarehouseLogistics:{validatePlan:value=>value},...mod};
  ctx.globalThis=ctx;vm.createContext(ctx);vm.runInContext(source,ctx);
  return ctx;
 };
 const input=(operationId,qty=1)=>({orderId,itemId,qty,date:'2026-10-29',notes:'送客戶',operationId,expectedPlan:plan});
 return{open,input,storage,requests,order,loseOnce(){throwsLost=true;},writes:()=>writes};
}
test('V3 Custody UI freezes first stock debit, survives lost reply and refresh, and recovers the same ID',async()=>{
 const f=fixture(),c=f.open({YUSHIN_V3_CUSTODY_SHIPMENT_EMULATOR:true});
 const input=f.input('custody_ship_ui_123456');
 f.loseOnce();await assert.rejects(c.commitV3CustodyShipment(input),/lost reply/);
 assert.equal(f.writes(),1);assert.equal(f.storage.size,1);
 await assert.rejects(c.commitV3CustodyShipment(f.input('custody_ship_ui_different')),
  /原操作編號/);
 assert.equal(f.writes(),1);
 const reloaded=f.open({YUSHIN_V3_CUSTODY_SHIPMENT_EMULATOR:true});
 assert.equal((await reloaded.window.resumeV3CustodyShipment('ORDER','I')).warehouseShipmentRecords.length,1);
 assert.equal(f.storage.size,0);
 assert.equal(f.writes(),1);
 assert.equal(f.requests[0].operationId,f.requests[1].operationId);
});
test('V3 Custody multi-line UI freezes and resumes the selected sibling item without changing its identity',async()=>{
 const f=fixture({multi:true}),ctx=f.open({YUSHIN_V3_CUSTODY_SHIPMENT_EMULATOR:true});
 const selected={...f.input('custody_ship_ui_multi_j'),itemId:'J'};
 f.loseOnce();await assert.rejects(ctx.commitV3CustodyShipment(selected),/lost reply/);
 assert.equal(f.requests[0].itemId,'J');
 assert.equal(f.order.warehouseShipmentRecords[0].custodyTransferId,'TRANSFER-J');
 assert.equal(f.storage.size,1);
 const reloaded=f.open({YUSHIN_V3_CUSTODY_SHIPMENT_EMULATOR:true});
 assert.equal((await reloaded.window.resumeV3CustodyShipment('ORDER','J')).warehouseShipmentRecords.length,1);
 assert.equal(f.storage.size,0);
 assert.deepEqual(f.requests.map(row=>row.itemId),['J','J']);
 assert.equal(f.writes(),1);
});
test('V3 Custody UI rejects disabled flag, wrong host, wrong project, changed Auth and keeps unresolved intent',async()=>{
 const f=fixture(),input=f.input('custody_ship_ui_reject');
 for(const flags of [{},{YUSHIN_V3_CUSTODY_SHIPMENT_EMULATOR:true,location:{hostname:'not-localhost'}},
  {YUSHIN_V3_CUSTODY_SHIPMENT_EMULATOR:true,currentUserRole:'warehouse'}]){
  const ctx=f.open(flags);
  await assert.rejects(ctx.commitV3CustodyShipment(input));
  assert.equal(f.requests.length,0);
 }
 const ctx=f.open({YUSHIN_V3_CUSTODY_SHIPMENT_EMULATOR:true});
 f.loseOnce();await assert.rejects(ctx.commitV3CustodyShipment(input));
 const disabled=f.open();
 await assert.rejects(disabled.window.resumeV3CustodyShipment('ORDER','I'),/禁止改用舊交易/);
 assert.equal(f.storage.size,1);
});
test('original order UI keeps V3 physical custody shipment separate from delivery confirmation and legacy stock writer',()=>{
 const ui=fs.readFileSync('src/features/orders/order-workspace.js','utf8');
 const legacy=fs.readFileSync('src/services/delivery-stock.js','utf8');
 const confirmation=fs.readFileSync('src/services/delivery-records.js','utf8');
 assert.match(ui,/openV3CustodyShipment/);
 assert.match(ui,/YUSHIN_V3_CUSTODY_SHIPMENT_EMULATOR/);
 assert.match(legacy,/if\(custodyV3\)throw new Error\('V3 業務保管/);
 assert.match(confirmation,/confirmV3CustodyDelivery/);
 assert.match(confirmation,/custodyV3:sourceCustody/);
});
