'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const logistics=require('../modules/warehouse-logistics');

function transferFixture(){
 const printed=[],reads=[];
 const warehouses=[{id:'MAIN',warehouseName:'主倉',contact:'主倉收貨',phone:'02-12345678',address:'台北市主倉地址'},{id:'BRANCH',warehouseName:'分倉'}];
 const order={id:'O1',orderNo:'O-001',status:'normal',shippingInstructions:{mode:'PICKUP'},items:[{itemId:'I1',itemCode:'DNA-01',itemName:'DNA Kit',warehouseId:'BRANCH',qty:2,reservedQty:2,dispatchPreparedQty:0}]};
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

function cardsFixture({phone='02-12345678',ready=true,hasMore=false,kind='branch',shipments=[]}={}){
 const nodes={warehouseParcelCards:{innerHTML:''},warehouseParcelStatus:{textContent:''}};
 const copied=[],shared=[],feedback=[];
 const entries=[
   {kind:'order',id:'O1',itemId:'I1',key:'order:O1:I1',warehouseId:'BRANCH',itemCode:'DNA-01',itemName:'DNA Kit',qty:2,source:'O-001',ready,recipient:{contact:'主倉收貨',phone,address:'台北市主倉地址',warehouseId:'MAIN'}},
   {kind:'stock',id:'R1',key:'stock:R1',warehouseId:'BRANCH',itemCode:'PCR-01',itemName:'PCR Mix',qty:3,source:'主倉備貨',ready:true,recipient:{contact:'主倉收貨',phone,address:'台北市主倉地址',warehouseId:'MAIN'}}
 ];
 const ctx={document:{getElementById:id=>nodes[id]||null},currentUser:{uid:'U1'},currentUserRole:'warehouse',
  canReceiveInventoryCapability:()=>true,canAccessPage:()=>true,canManageInventoryStockPolicy:()=>false,canEditPage:()=>false,
  firebase:{app:()=>({options:{projectId:'TEST'}})},localStorage:{getItem:()=>null},
  navigator:{clipboard:{writeText:async message=>{copied.push(message);}},share:async request=>{shared.push(request);}},
  localDateString:()=> '2026-11-09',showActionFeedback:(message,type)=>feedback.push({message,type}),
  warehouseMasterCache:[{id:'MAIN',warehouseName:'主倉'},{id:'BRANCH',warehouseName:'分倉'}],defaultWarehouse:()=>({id:'MAIN'}),
  orderWorkQueueReady:true,orderWorkQueueError:'',warehouseParcelSourceRows:()=>shipments,inventoryShippingActiveKind:()=>kind,
  mainTransferParcelEntries:()=>({ready:true,error:'',entries,recoveries:[],hasMore}),
  escapeHtml:String,inlineJsValue:JSON.stringify,YushinWarehouseLogistics:logistics};
 const c=vm.createContext(ctx);vm.runInContext(fs.readFileSync('modules/warehouse-parcels.js','utf8'),c);return {c,nodes,copied,shared,feedback,entries};
}

test('both transfer sources appear as ordinary shipping cards with their original dispatch actions',()=>{
 const {c,nodes}=cardsFixture();c.renderWarehouseParcels();
 const html=nodes.warehouseParcelCards.innerHTML;
 assert.equal((html.match(/parcel-simple-card/g)||[]).length,2);
 assert.doesNotMatch(html,/parcel-branch-confirmations/);
 assert.match(html,/逐筆確認寄出/);
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

test('branch shipping appears as one warehouse-based list, ready to copy for LINE without writing stock',async()=>{
 const shipment={key:'O2__I2',order:{id:'O2',orderNo:'O-002',shippingInstructions:{mode:'CUSTOMER_SHIP'}},
  item:{itemId:'I2',itemCode:'SALE-01',itemName:'試劑',deliveryPlan:{mode:'CUSTOMER_SHIP',contact:'客戶收件人',phone:'02-98765432',address:'台北市客戶地址'}},
  warehouseId:'BRANCH',qty:1};
 const {c,nodes,copied}=cardsFixture({shipments:[shipment]});c.renderWarehouseParcels();
 const html=nodes.warehouseParcelCards.innerHTML;
 assert.equal((html.match(/data-branch-list=/g)||[]).length,1);
 assert.match(html,/分倉出貨清單/);assert.match(html,/SALE-01/);
 assert.match(html,/寄給客戶/);assert.match(html,/訂單調回主倉/);assert.match(html,/備貨調回主倉/);
 const button={disabled:false};await c.shareBranchDispatchList('BRANCH',false,button);
 assert.equal(copied.length,1);assert.equal(button.disabled,false);
 assert.match(copied[0],/O-001/);assert.match(copied[0],/O-002/);
 assert.match(copied[0],/PCR-01/);assert.match(copied[0],/台北市客戶地址/);
 assert.match(copied[0],/不代表系統已出庫/);
 assert.doesNotMatch(copied[0],/unitCost|成本|售價/);
});

test('native phone sharing keeps the current warehouse list and does not require a backend write',async()=>{
 const {c,shared}=cardsFixture();c.renderWarehouseParcels();
 await c.shareBranchDispatchList('BRANCH',true,{disabled:false});
 assert.equal(shared.length,1);assert.match(shared[0].title,/分倉出貨通知/);
 assert.match(shared[0].text,/DNA-01/);
});

test('not-yet-ready transfer is visible for preparation, but clearly says it cannot be sent',async()=>{
 const {c,nodes,copied}=cardsFixture({ready:false});c.renderWarehouseParcels();
 assert.match(nodes.warehouseParcelCards.innerHTML,/待備妥／打單/);
 await c.shareBranchDispatchList('BRANCH',false,{disabled:false});
 assert.match(copied[0],/不可先寄出/);
});

test('incomplete recipient, incomplete transfer page and changed quantities fail closed when sharing',async()=>{
 const missing=cardsFixture({phone:''});missing.c.renderWarehouseParcels();
 assert.match(missing.nodes.warehouseParcelCards.innerHTML,/disabled>複製清單/);
 await missing.c.shareBranchDispatchList('BRANCH',false,{disabled:false});
 assert.equal(missing.copied.length,0);assert.match(missing.feedback[0].message,/收件資料不完整/);
 const more=cardsFixture({hasMore:true});more.c.renderWarehouseParcels();
 await more.c.shareBranchDispatchList('BRANCH',false,{disabled:false});
 assert.equal(more.copied.length,0);assert.match(more.feedback[0].message,/尚未完整讀取/);
 const changed=cardsFixture();changed.c.renderWarehouseParcels();changed.entries[0].qty=4;
 await changed.c.shareBranchDispatchList('BRANCH',false,{disabled:false});
 assert.equal(changed.copied.length,0);assert.match(changed.feedback[0].message,/清單內容已更新/);
});

test('main warehouse view does not render outbound branch list',()=>{
 const {c,nodes}=cardsFixture({kind:'main'});c.renderWarehouseParcels();
 assert.doesNotMatch(nodes.warehouseParcelCards.innerHTML,/分倉出貨清單/);
});

test('each warehouse receives only its own shipping requirements',async()=>{
 const shipment={key:'O3__I3',order:{id:'O3',orderNo:'O-003'},item:{itemId:'I3',itemCode:'OTHER-01',itemName:'獨立分倉貨品',
  deliveryPlan:{mode:'CUSTOMER_SHIP',contact:'另一收件人',phone:'02-20000000',address:'獨立地址'}},warehouseId:'BRANCH2',qty:2};
 const {c,nodes,copied}=cardsFixture({shipments:[shipment]});
 c.warehouseMasterCache.push({id:'BRANCH2',warehouseName:'另一分倉'});c.renderWarehouseParcels();
 assert.equal((nodes.warehouseParcelCards.innerHTML.match(/data-branch-list=/g)||[]).length,2);
 await c.shareBranchDispatchList('BRANCH',false,{disabled:false});
 assert.equal(copied.length,1);assert.doesNotMatch(copied[0],/OTHER-01|獨立地址/);
 await c.shareBranchDispatchList('BRANCH2',false,{disabled:false});
 assert.match(copied[1],/OTHER-01|獨立地址/);assert.doesNotMatch(copied[1],/DNA-01|PCR-01/);
});

test('role changes cannot share a list rendered for the previous identity',async()=>{
 const {c,copied,feedback}=cardsFixture();c.renderWarehouseParcels();
 c.currentUserRole='admin';await c.shareBranchDispatchList('BRANCH',false,{disabled:false});
 assert.equal(copied.length,0);assert.match(feedback[0].message,/登入帳號或角色已變更/);
});
