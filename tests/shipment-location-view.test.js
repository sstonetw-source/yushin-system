'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('src/features/inventory/inventory-workspace.js','utf8').split('// End v2 shipment location projection.')[0];
const workspace=require('../modules/inventory-workspace'),reservation=require('../modules/reservation-core');
function fixture(){
 const item={itemId:'I',productId:'P',warehouseId:'A',reservedQty:8,shortageQty:0,dispatchPreparedQty:9,warehouseShippedQty:4,deliveryPlan:{mode:'CUSTOMER_SHIP'}};
 const order={id:'O',ownerUid:'sales',salesCode:'S',inventoryReservationAttemptId:'sync',items:[item]};
 const ledger={orderId:'O',itemId:'I',productKey:'P',ownerUid:'sales',salesCode:'S',quantity:8,shortageQty:0,status:'active',locationSchemaVersion:2,locations:[{warehouseId:'A',reservedQty:3},{warehouseId:'B',reservedQty:5}]};
 let reads=0,load=async()=>ledger;
 const auth={app:{options:{projectId:'demo-yushin'}},currentUser:{uid:'warehouse'}};
 const c=vm.createContext({window:null,YUSHIN_V2_SHIPMENT_EMULATOR:true,APP_ENVIRONMENT:'emulator',location:{hostname:'localhost'},
  currentUser:{uid:'warehouse'},currentUserRole:'warehouse',canReceiveInventoryCapability:()=>true,canAccessPage:()=>true,
  firebase:{auth:()=>auth},normalizedOrderStatus:()=> 'normal',orderInventorySyncIncomplete:()=>false,normalizedOrderItems:o=>o.items,
  itemDispatchState:()=>({shippable:5}),inventoryProductKey:item=>item.productId,YushinReservation:reservation,
  db:{app:{options:{projectId:'demo-yushin'}},collection:name=>({doc:id=>({get:async options=>{reads++;assert.equal(name,'inventoryReservations');assert.equal(options.source,'server');const data=await load(id);return {exists:!!data,data:()=>data};}})})}});
 c.window=c;vm.runInContext(source,c);
 return {c,order,item,ledger,auth,reads:()=>reads,setLoad:fn=>load=fn};
}
test('real reservation locations yield separate warehouse rows capped by shared dispatch allowance',async()=>{
 const f=fixture();await f.c.loadV2WarehouseShipmentLocations([f.order]);
 const helpers={status:()=> 'normal',incomplete:()=>false,items:o=>o.items,dispatch:()=>({shippable:5}),locations:f.c.v2WarehouseShipmentLocations};
 const rows=workspace.shippingRows([f.order],[{id:'A'},{id:'B'}],'A',helpers);
 assert.deepEqual(rows.map(row=>[row.warehouseId,row.qty,row.key]),[['A',3,'O__I__A'],['B',5,'O__I__B']]);
 assert.equal(f.reads(),1);assert.equal(f.item.warehouseId,'A');
 f.item.reservedQty=7;assert.equal(f.c.v2WarehouseShipmentLocations(f.order,f.item),null);
 assert.equal(workspace.shippingRows([f.order],[{id:'A'},{id:'B'}],'A',helpers).length,0,'stale positions cannot fall back to assigned warehouse');
});
test('failed or malformed location refresh clears old projection and performs no fallback',async()=>{
 const f=fixture();await f.c.loadV2WarehouseShipmentLocations([f.order]);
 for(const invalid of [null,{...f.ledger,quantity:9},{...f.ledger,productKey:'OTHER'},{...f.ledger,status:'released'},{...f.ledger,locations:[{warehouseId:'A',qty:3}]}]){
  f.setLoad(async()=>invalid);await assert.rejects(f.c.loadV2WarehouseShipmentLocations([f.order]));
  assert.equal(f.c.v2WarehouseShipmentLocations(f.order,f.item),null);
 }
});
test('account switch and reset invalidate late location reads',async()=>{
 const f=fixture();let release;f.setLoad(()=>new Promise(resolve=>release=resolve));
 const loading=f.c.loadV2WarehouseShipmentLocations([f.order]);f.c.currentUser={uid:'other'};release(f.ledger);await loading;
 assert.equal(f.c.v2WarehouseShipmentLocations(f.order,f.item),null);
 f.c.currentUser={uid:'warehouse'};f.setLoad(async()=>f.ledger);await f.c.loadV2WarehouseShipmentLocations([f.order]);
 f.c.resetV2ShipmentLocations();assert.equal(f.c.v2WarehouseShipmentLocations(f.order,f.item),null);
});
test('location reads are bounded and cannot run against another account or remote project',async()=>{
 const f=fixture();const many=Array.from({length:201},(_,i)=>({...f.order,id:'O'+i}));
 await assert.rejects(f.c.loadV2WarehouseShipmentLocations(many),/200/);assert.equal(f.reads(),0);
 f.auth.currentUser.uid='other';await assert.rejects(f.c.loadV2WarehouseShipmentLocations([f.order]));assert.equal(f.reads(),0);
 f.c.YUSHIN_V2_SHIPMENT_EMULATOR=false;await f.c.loadV2WarehouseShipmentLocations([f.order]);assert.equal(f.reads(),0);
});
test('Preview location reads require the independent flag, canonical site, project and Auth',async()=>{
 const f=fixture();f.c.YUSHIN_V2_SHIPMENT_EMULATOR=false;f.c.YUSHIN_PREVIEW_SHIPMENT=true;
 f.c.APP_ENVIRONMENT='preview';f.c.location.hostname='preview-20135.web.app';
 f.auth.app.options.projectId='preview-20135';f.c.db.app.options.projectId='preview-20135';
 await f.c.loadV2WarehouseShipmentLocations([f.order]);assert.equal(f.reads(),1);
 assert.equal(f.c.v2WarehouseShipmentLocations(f.order,f.item).length,2);
 f.c.YUSHIN_PREVIEW_SHIPMENT=false;
 assert.equal(f.c.v2WarehouseShipmentLocations(f.order,f.item),undefined);
 f.c.YUSHIN_PREVIEW_SHIPMENT=true;f.c.location.hostname='example.com';
 await assert.rejects(f.c.loadV2WarehouseShipmentLocations([f.order]),/受控/);
 assert.equal(f.reads(),1);
});
test('unknown shipment reply remains on its original warehouse even when there is no remaining dispatch quota',()=>{
 const f=fixture(),helpers={status:()=> 'normal',incomplete:()=>false,items:o=>o.items,dispatch:()=>({shippable:0}),locations:()=>null,
  pending:()=>({warehouseId:'B',quantity:5})};
 const rows=workspace.shippingRows([f.order],[{id:'A'},{id:'B'}],'A',helpers);
 assert.deepEqual(rows.map(row=>[row.warehouseId,row.qty,row.key]),[['B',5,'O__I__B']]);
});


test('post-shipment location validation uses stored source quantities rather than legacy display shortage',async()=>{
 const f=fixture();f.item.shortageQty=3;f.ledger.shortageQty=3;
 const displayed={...f.item,shortageQty:5};f.c.normalizedOrderItems=()=>[displayed];
 await f.c.loadV2WarehouseShipmentLocations([f.order]);
 assert.deepEqual(JSON.parse(JSON.stringify(f.c.v2WarehouseShipmentLocations(f.order,displayed))),[{warehouseId:'A',qty:3},{warehouseId:'B',qty:5}]);
 f.item.shortageQty=2;assert.equal(f.c.v2WarehouseShipmentLocations(f.order,displayed),null,'stored source changes still invalidate projection');
});
