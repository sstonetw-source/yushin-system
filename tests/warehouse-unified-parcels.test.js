'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const logistics=require('../modules/warehouse-logistics');

function transferFixture(){
 const printed=[],reads=[];
 const warehouses=[{id:'MAIN',warehouseName:'主倉',contact:'主倉收貨',phone:'02-12345678',address:'台北市主倉地址'},{id:'BRANCH',warehouseName:'分倉'}];
 const order={id:'O1',orderNo:'O-001',status:'normal',shippingInstructions:{mode:'PICKUP'},items:[{itemId:'I1',itemCode:'DNA-01',itemName:'DNA Kit',warehouseId:'BRANCH',qty:2}]};
 const c=vm.createContext({document:{getElementById:()=>null},currentUser:{uid:'U1'},currentUserRole:'warehouse',
  canReceiveInventoryCapability:()=>true,canAccessPage:()=>true,canManageInventoryStockPolicy:()=>false,canEditPage:()=>false,
  defaultWarehouse:()=>warehouses[0],warehouseMasterCache:warehouses,orderWorkQueueCache:[order],
  normalizedOrderStatus:o=>o.status,orderInventorySyncIncomplete:()=>false,normalizedOrderItems:o=>o.items,
  itemDispatchState:()=>({shippable:2}),YushinWarehouseLogistics:logistics,
  db:{collection:name=>({where:(field,op,value)=>{reads.push([name,field,op,value]);return {limit:()=>({get:async()=>({docs:[{id:'R1',data:()=>({inventoryId:'P1',fromWarehouseId:'BRANCH',toWarehouseId:'MAIN',itemCode:'PCR-01',itemName:'PCR Mix',qty:3})}]})})};}})},
  firestoreReadWithTimeout:promise=>promise,printWarehouseAddressGroups:groups=>printed.push(groups),
  showActionFeedback:()=>{},escapeHtml:String,inlineJsValue:JSON.stringify});
 vm.runInContext(fs.readFileSync('modules/main-warehouse-transfers.js','utf8'),c);
 return {c,reads,printed,warehouses};
}

test('branch-to-main order and replenishment share recipient projection without another writer or query',async()=>{
 const {c,reads,printed,warehouses}=transferFixture();
 await c.loadMainTransferRequests();
 const result=c.mainTransferParcelEntries();
 assert.equal(result.ready,true);assert.equal(result.entries.length,2);
 assert.deepEqual(Array.from(result.entries.map(r=>r.kind)),['order','stock']);
 assert.equal(result.entries[0].key,'order:O1:I1');assert.equal(result.entries[1].key,'stock:R1');
 assert.equal(result.entries[0].source,'O-001');assert.equal(result.entries[0].ready,true);
 assert.equal(result.entries[1].qty,3);
 assert.equal(result.entries[0].recipient.address,warehouses[0].address);
 assert.equal(result.entries[1].recipient.phone,warehouses[0].phone);
 c.printMainTransferParcel('stock','R1','',{});
 assert.equal(printed.length,1);assert.equal(printed[0][0].plan.warehouseId,'MAIN');
 assert.equal(reads.length,1);assert.deepEqual(Array.from(reads[0]),['stockTransferRequests','status','==','PENDING']);
});

function cardsFixture({phone='02-12345678',ready=true}={}){
 const nodes={warehouseParcelCards:{innerHTML:''},warehouseParcelStatus:{textContent:''}};
 const ctx={document:{getElementById:id=>nodes[id]||null},currentUser:{uid:'U1'},currentUserRole:'warehouse',
  canReceiveInventoryCapability:()=>true,canAccessPage:()=>true,canManageInventoryStockPolicy:()=>false,canEditPage:()=>false,
  firebase:{app:()=>({options:{projectId:'TEST'}})},localStorage:{getItem:()=>null},
  warehouseMasterCache:[{id:'MAIN',warehouseName:'主倉'},{id:'BRANCH',warehouseName:'分倉'}],defaultWarehouse:()=>({id:'MAIN'}),
  orderWorkQueueReady:true,orderWorkQueueError:'',warehouseParcelSourceRows:()=>[],inventoryShippingActiveKind:()=> 'branch',
  mainTransferParcelEntries:()=>({ready,error:'',entries:[
   {kind:'order',id:'O1',itemId:'I1',warehouseId:'BRANCH',itemCode:'DNA-01',itemName:'DNA Kit',qty:2,source:'O-001',ready:true,recipient:{contact:'主倉收貨',phone,address:'台北市主倉地址',warehouseId:'MAIN'}},
   {kind:'stock',id:'R1',warehouseId:'BRANCH',itemCode:'PCR-01',itemName:'PCR Mix',qty:3,source:'主倉備貨',ready:true,recipient:{contact:'主倉收貨',phone,address:'台北市主倉地址',warehouseId:'MAIN'}}
  ],recoveries:[],hasMore:false}),
  escapeHtml:String,inlineJsValue:JSON.stringify,YushinWarehouseLogistics:logistics};
 const c=vm.createContext(ctx);vm.runInContext(fs.readFileSync('modules/warehouse-parcels.js','utf8'),c);return {c,nodes};
}

test('both transfer sources appear as ordinary shipping cards with their original dispatch actions',()=>{
 const {c,nodes}=cardsFixture();c.renderWarehouseParcels();
 const html=nodes.warehouseParcelCards.innerHTML;
 assert.equal((html.match(/parcel-simple-card/g)||[]).length,2);
 assert.match(html,/主倉收貨/);assert.match(html,/台北市主倉地址/);
 assert.match(html,/DNA-01/);assert.match(html,/PCR-01/);
 assert.match(html,/startOrderWarehouseTransfer/);assert.match(html,/dispatchMainTransferRequest/);
 assert.doesNotMatch(html,/warehouse-task-row|批次操作|寄回主倉區塊/);
});

test('missing master-warehouse contact blocks both physical dispatch actions in cards',()=>{
 const {c,nodes}=cardsFixture({phone:''});c.renderWarehouseParcels();
 const html=nodes.warehouseParcelCards.innerHTML;
 assert.match(html,/主倉收件資料未完整/);
 assert.equal((html.match(/>確認寄出<\/button>/g)||[]).length,2);
 assert.equal((html.match(/disabled>確認寄出/g)||[]).length,2);
});
