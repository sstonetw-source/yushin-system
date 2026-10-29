'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {custodyDeliveryProject,commitCustodyDelivery}=require('../functions/custody-delivery-service');
const {shipmentDeliveryContext}=require('../functions/shipment-delivery-service');
const env={GCLOUD_PROJECT:'demo-yushin',FUNCTIONS_EMULATOR:'true',
 FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099',
 ENABLE_V3_CUSTODY_DELIVERY_EMULATOR:'true'};
test('V3 custody delivery is independently and unconditionally closed outside demo Auth/Functions/Firestore Emulator',async()=>{
 assert.equal(custodyDeliveryProject(env),'demo-yushin');
 for(const patch of [{GCLOUD_PROJECT:'production'},{FUNCTIONS_EMULATOR:'false'},
  {ENABLE_V3_CUSTODY_DELIVERY_EMULATOR:'false'},
  {FIRESTORE_EMULATOR_HOST:'remote-db:8080'},{FIREBASE_AUTH_EMULATOR_HOST:'remote-auth:9099'}]){
  assert.equal(custodyDeliveryProject({...env,...patch}),'');
  await assert.rejects(commitCustodyDelivery({projectId:'demo-yushin'},'U',{}, {...env,...patch}));
 }
 await assert.rejects(commitCustodyDelivery({projectId:'production'},'U',{},env));
});
test('existing v2 delivery confirmation refuses V3 sources without the independently gated V3 context',()=>{
 const plan={mode:'CUSTOMER_SHIP',contact:'Customer',phone:'0222222222',address:'Address',
  warehouseId:'',packages:1,notes:''};
 const order={status:'active',orderStatus:'normal',ownerUid:'U',salesCode:'S01',
  inventoryReservationStatus:'completed',inventoryReservationAttemptId:'sync_123456789',
  logisticsTransfersPending:0,deliveredQty:0,returnedQty:0,isDelivered:false,
  items:[{itemId:'I',productId:'P',qty:3,warehouseId:'custody-U',custodyTransferId:'T',
   reservedQty:2,warehouseShippedQty:1,dispatchPreparedQty:3,deliveredQty:0,returnedQty:0}],
  warehouseShipmentRecords:[{id:'ship_123456789',orderId:'ORDER',itemId:'I',productKey:'P',
   warehouseId:'custody-U',qty:1,date:'2026-10-29',notes:'',sourceType:'WAREHOUSE_CUSTOMER_SHIPMENT',
   movementId:'location-ship-ship_123456789',deliveryPlan:plan,custodyTransferId:'T',
   lotAllocations:[{lotId:'T-0',qty:1}]}],deliveryRecords:[],returnRecords:[]};
 const intent={orderId:'ORDER',itemId:'I',syncAttemptId:'sync_123456789'};
 assert.throws(()=>shipmentDeliveryContext(order,intent,{allowReturns:true}),/不是可確認的實體倉出貨/);
 const context=shipmentDeliveryContext(order,intent,{allowReturns:true,allowCustody:true});
 assert.equal(context.item.custodyTransferId,'T');
 assert.equal(context.returnProjection.outstandingQty,2);
});
