'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('src/services/delivery-records.js','utf8');

test('V3 Custody multi-line client confirmation freezes the selected shipment across a lost response',async()=>{
 const orderId='ORDER',uid='SALES',storage=new Map(),calls=[];
 const plan={mode:'CUSTOMER_SHIP',contact:'Contact',phone:'0222222222',address:'Address',
  warehouseId:'',packages:1,notes:''};
 const order={ownerUid:uid,inventoryReservationStatus:'completed',
  inventoryReservationAttemptId:'sync_123456789',items:[
   {itemId:'I',qty:2,productId:'P',warehouseId:'custody-SALES',custodyTransferId:'T-I'},
   {itemId:'J',qty:1,productId:'Q',warehouseId:'custody-SALES',custodyTransferId:'T-J'}],
  warehouseShipmentRecords:[{id:'custody_ship_multi_j',itemId:'J',warehouseId:'custody-SALES',
   custodyTransferId:'T-J',deliveryPlan:plan}],deliveryRecords:[],returnRecords:[]};
 let lost=true;
 const options={projectId:'demo-yushin'};
 const auth={app:{options},currentUser:{uid},emulatorConfig:{host:'127.0.0.1',port:9099}};
 const functions={app:{options},useEmulator(host,port){assert.equal(host,'127.0.0.1');assert.equal(port,5001);},
  httpsCallable(name){assert.equal(name,'confirmV3CustodyDelivery');return async data=>{
   calls.push(structuredClone(data));
   if(!order.deliveryRecords.some(row=>row.id===data.operationId))order.deliveryRecords.push({
    id:data.operationId,itemId:data.itemId,shipmentId:data.shipmentId,qty:data.quantity,
    date:data.date,notes:data.notes,sourceType:'WAREHOUSE_SHIPMENT_CONFIRMATION'});
   if(lost){lost=false;throw Error('lost delivery response');}
   return{data:{status:'already-applied',recordId:data.operationId,orderId,
    itemId:data.itemId,shipmentId:data.shipmentId}};
  };}};
 const app={options,functions:()=>functions};
 const db={app,collection(name){return{doc(){return{async get(){
  if(name!=='orders')throw Error('unexpected database collection');
  return{exists:true,data:()=>structuredClone(order)};
 }};}};}};
 const open=()=>{
  const c=vm.createContext({YUSHIN_V3_CUSTODY_DELIVERY_EMULATOR:true,
   location:{hostname:'localhost'},currentUser:{uid},currentUserRole:'sales',
   firebase:{app:()=>app,auth:()=>auth,functions:()=>functions},db,
   sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),
    removeItem:key=>storage.delete(key)},canManageOrderLifecycleCapability:()=>true,
   canEditPage:()=>true,YushinFulfillment:{projectOrderShipmentReturns:()=>({
    items:[{itemId:'J',shipments:[{shipmentId:'custody_ship_multi_j',pendingQty:1}]}]})}});
  c.globalThis=c;vm.runInContext(source,c);return c;
 };
 const input={date:'2026-10-30',qty:1,notes:'客戶簽收',itemId:'J',
  shipmentId:'custody_ship_multi_j',recordId:'custody_ack_multi_j',custodyV3:true};
 await assert.rejects(open().confirmV2ShipmentDeliveryEmulator(orderId,input),/lost delivery response/);
 assert.equal(storage.size,1);
 assert.equal(calls[0].itemId,'J');
 assert.equal(calls[0].shipmentId,'custody_ship_multi_j');
 const reloaded=open();
 await assert.rejects(reloaded.confirmV2ShipmentDeliveryEmulator(orderId,{...input,itemId:'I'}),/未確認/);
 const result=await reloaded.confirmV2ShipmentDeliveryEmulator(orderId,input);
 assert.equal(result.deliveryRecords[0].itemId,'J');
 assert.deepEqual(calls.map(row=>row.operationId),['custody_ack_multi_j','custody_ack_multi_j']);
 assert.equal(storage.size,0);
});
