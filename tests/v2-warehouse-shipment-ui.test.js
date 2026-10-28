'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('src/services/warehouse-shipment.js','utf8');
const logistics=require('../modules/warehouse-logistics');
const base={orderId:'O',itemId:'I',qty:2,date:'2026-10-19',notes:'',
 operationId:'shipment_ui_123456',expectedWarehouseId:'B',
 expectedPlan:{mode:'CUSTOMER_SHIP',contact:'Customer',phone:'02-12345678',address:'Taipei'}};
function setup({host='localhost',authUid='buyer',lost=true}={}){
 const storage=new Map(),seen=new Set(),sent=[];
 let applied=0;
 const order={inventoryReservationStatus:'completed',inventoryReservationAttemptId:'attempt-1',
  items:[{itemId:'I',productId:'P',qty:5,warehouseId:'A'}]};
 const app={options:{projectId:'demo-yushin'}};
 const auth={app,currentUser:{uid:authUid},emulatorConfig:{host:'127.0.0.1',port:9099}};
 const functions={app,useEmulator(){},
  httpsCallable:()=>async data=>{
   sent.push(data);
   if(!seen.has(data.operationId)){seen.add(data.operationId);applied++;
    order.warehouseShipmentRecords=[{id:data.operationId,orderId:data.orderId,itemId:data.itemId,
      warehouseId:data.warehouseId,qty:data.quantity,date:data.date,notes:data.notes,deliveryPlan:data.expectedPlan}];}
   if(lost){lost=false;throw Error('response lost');}
   return {data:{status:'already-applied',orderId:data.orderId,itemId:data.itemId,
    warehouseId:data.warehouseId,qty:data.quantity,movementId:'location-ship-'+data.operationId}};
  }};
 const c=vm.createContext({currentUser:{uid:'buyer'},currentUserRole:'purchaser',
  YUSHIN_V2_SHIPMENT_EMULATOR:true,location:{hostname:host},
  YushinWarehouseLogistics:logistics,canReceiveInventoryCapability:()=>true,canAccessPage:()=>true,
  sessionStorage:{getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},
  db:{app,collection:()=>({doc:()=>({get:async()=>({exists:true,data:()=>order})})})},
  firebase:{app:()=>({options:app.options,functions:()=>functions}),auth:()=>auth,functions:()=>functions},
  runRoleTransaction:()=>{throw Error('legacy write prohibited');}});
 vm.runInContext(source,c);
 return {c,storage,sent,app,auth,order,applied:()=>applied};
}
test('v2 shipment keeps original id after unknown response and safely retries',async()=>{
 const f=setup();
 await assert.rejects(f.c.commitInventoryShipment(base),/response lost/);
 assert.equal(f.applied(),1);
 const original=f.c.pendingV2WarehouseShipment('O','I');
 assert.equal(original.syncAttemptId,'attempt-1');
 assert.equal(original.actorUid,'buyer');
 assert.equal(original.warehouseId,'B');
 await assert.rejects(f.c.commitInventoryShipment({...base,qty:3}),/凍結/);
 await assert.rejects(f.c.commitInventoryShipment({...base,operationId:'new_shipment_12345'}),/識別碼/);
 assert.equal(f.sent.length,1);
 await f.c.commitInventoryShipment(base);
 assert.equal(f.applied(),1);
 assert.equal(f.c.pendingV2WarehouseShipment('O','I'),null);
 assert.deepEqual(f.sent.map(x=>x.operationId),[base.operationId,base.operationId]);
});
test('v2 shipment rejects remote browser, wrong signed-in uid and bad dates before legacy writer',async()=>{
 for(const config of [{host:'remote.example'},{authUid:'different'}]){
  const f=setup(config);
  await assert.rejects(f.c.commitInventoryShipment(base),/本機|帳號|權限|尚未.*啟用/);
  assert.equal(f.sent.length,0);
 }
 const f=setup({lost:false});
 await assert.rejects(f.c.commitInventoryShipment({...base,date:'2026-02-30'}),/不正確/);
 await assert.rejects(f.c.commitInventoryShipment({...base,qty:0}),/不正確/);
 assert.equal(f.storage.size,0);
});
test('unknown backend result cannot fall back to legacy on Preview, flag change or malformed stored attempt',async()=>{
 const x=setup();await assert.rejects(x.c.commitInventoryShipment(base),/response lost/);
 x.c.YUSHIN_V2_SHIPMENT_EMULATOR=false;
 await assert.rejects(x.c.commitInventoryShipment(base),/不得改走一般交易/);
 assert.equal(x.applied(),1);
 const y=setup({lost:false});y.c.APP_ENVIRONMENT='preview';y.c.YUSHIN_V2_SHIPMENT_EMULATOR=false;y.c.YUSHIN_PREVIEW_SHIPMENT=false;
 await assert.rejects(y.c.commitInventoryShipment(base),/不得改走一般交易/);
 assert.equal(y.applied(),0);
 const z=setup();z.storage.set('v2-shipment:buyer:O:I','{broken');
 await assert.rejects(z.c.commitInventoryShipment(base),/核對出貨識別資料/);
 assert.equal(z.applied(),0);
});
test('Preview shipment binds explicit host, project and non-Emulator Auth before writing',async()=>{
 const x=setup({lost:false});x.c.APP_ENVIRONMENT='preview';x.c.YUSHIN_V2_SHIPMENT_EMULATOR=false;
 x.c.YUSHIN_PREVIEW_SHIPMENT=true;x.c.location.hostname='preview-20135.web.app';
 await assert.rejects(x.c.commitInventoryShipment(base),/專案不一致/);
 assert.equal(x.applied(),0);
 const y=setup({lost:false});y.c.APP_ENVIRONMENT='preview';y.c.YUSHIN_V2_SHIPMENT_EMULATOR=false;
 y.c.YUSHIN_PREVIEW_SHIPMENT=true;y.c.location.hostname='example.com';
 await assert.rejects(y.c.commitInventoryShipment(base),/尚未.*啟用/);
 assert.equal(y.applied(),0);
});
test('Preview retries the frozen operation and keeps it pending until server order proves the physical shipment',async()=>{
 const x=setup();x.c.APP_ENVIRONMENT='preview';x.c.YUSHIN_V2_SHIPMENT_EMULATOR=false;
 x.c.YUSHIN_PREVIEW_SHIPMENT=true;x.c.location.hostname='preview-20135.web.app';
 x.app.options.projectId='preview-20135';delete x.auth.emulatorConfig;
 await assert.rejects(x.c.commitInventoryShipment(base),/response lost/);
 const pending=x.c.pendingV2WarehouseShipment('O','I');assert.equal(pending.operationId,base.operationId);
 const actual=x.order.warehouseShipmentRecords;
 x.order.warehouseShipmentRecords=[];
 await assert.rejects(x.c.commitInventoryShipment(base),/尚未證實原交易/);
 assert.equal(x.c.pendingV2WarehouseShipment('O','I').operationId,base.operationId);
 x.order.warehouseShipmentRecords=actual;
 await x.c.commitInventoryShipment(base);
 assert.equal(x.applied(),1);assert.deepEqual(x.sent.map(row=>row.operationId),Array(3).fill(base.operationId));
 assert.equal(x.c.pendingV2WarehouseShipment('O','I'),null);
});
test('pending v2 shipment stays visible when current shippable stock reaches zero',()=>{
 const workspace=require('../modules/inventory-workspace');
 const orders=[{id:'O',items:[{itemId:'I',qty:5,warehouseId:'A'}]}];
 const warehouse=[{id:'A',active:true},{id:'B',active:true}];
 const helpers={status:()=> 'normal',incomplete:()=>false,items:o=>o.items,
  dispatch:()=>({shippable:0}),pending:()=>({quantity:2,warehouseId:'B'})};
 const rows=workspace.shippingRows(orders,warehouse,'A',helpers);
 assert.equal(rows.length,1);assert.equal(rows[0].warehouseId,'B');assert.equal(rows[0].qty,2);
 assert.equal(workspace.shippingRows(orders,warehouse,'A',{...helpers,pending:undefined}).length,0);
});
