'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const code=fs.readFileSync('src/features/inventory/customer-return-receiving.js','utf8');
function fixture(){
 const storage=new Map(),nodes=new Map(),calls=[],alerts=[];let failRefresh=false,read=()=>structuredClone(order),pending=null,send=async intent=>({...order,id:'O',returnRequests:[{...order.returnRequests[0],receivedQty:1}]});
 const element=id=>{if(!nodes.has(id))nodes.set(id,{innerHTML:'',textContent:'',value:'',checked:false,disabled:false,classList:{add(){},remove(){}}});return nodes.get(id);};
 const source={orderId:'O',itemId:'I',productKey:'P',warehouseId:'A',qty:2,date:'2026-10-20'};
 const order={id:'O',inventoryReservationAttemptId:'sync',items:[{itemId:'I',productId:'P',qty:2}],
  returnRequests:[{id:'Q',itemId:'I',qty:2,receivedQty:0,status:'PENDING',reason:'訂錯貨'}],
  warehouseShipmentRecords:[{...source,id:'S',sourceType:'WAREHOUSE_CUSTOMER_SHIPMENT',lotAllocations:[{lotId:'L',lotNo:'BATCH',expiryDate:'2028-01-01',qty:2}]}],
  deliveryRecords:[{...source,id:'D',shipmentId:'S',sourceType:'WAREHOUSE_SHIPMENT_CONFIRMATION'}],returnRecords:[]};
 const c=vm.createContext({currentUser:{uid:'U'},currentUserRole:'warehouse',sessionDataGeneration:1,YUSHIN_V2_RETURN_RECEIPT_EMULATOR:true,
  YushinFulfillment:require('../modules/fulfillment-core'),YushinInventory:require('../modules/inventory-core'),
  canReceiveInventoryCapability:()=>['warehouse','purchaser','admin'].includes(c.currentUserRole),v2CustomerReturnTransport:()=>{if(!c.canReceiveInventoryCapability())throw Error('role changed');return {uid:c.currentUser.uid,role:c.currentUserRole};},
  pendingV2CustomerReturnReceipt:()=>{if(pending instanceof Error)throw pending;return pending;},normalizeV2CustomerReturnReceipt:intent=>c.YushinFulfillment.normalizeLocationReturnIntent(intent),
  sessionStorage:{get length(){return storage.size;},key:i=>[...storage.keys()][i],getItem:k=>storage.get(k)??null},
  document:{getElementById:element},escapeHtml:x=>String(x).replaceAll('<','&lt;'),escapeAttr:x=>String(x).replaceAll('"','&quot;'),inlineJsValue:JSON.stringify,
  db:{collection:()=>({doc:()=>({get:async options=>{assert.equal(options.source,'server');const result=await read();return {exists:true,data:()=>result};}})})},
  localDateString:()=> '2026-10-21',lifecycleRecordId:()=> 'receipt_ui_operation_001',alert:m=>alerts.push(m),
  receiveV2CustomerReturnEmulator:async(id,intent)=>{assert.equal(id,'O');calls.push(structuredClone(intent));return send(intent);},
  invalidateWarehouseStockCache:()=>{},markMainPageDirty:()=>{},refreshAffectedOrderCaches:async()=>{if(failRefresh)throw Error('refresh failed');},loadCustomerReturnQueue:async()=>{},showActionFeedback:()=>{}});
 c.window=c;vm.runInContext(code,c);
 const prepare=async()=>{await c.openCustomerReturnReceipt('O','Q');element('customerReturnReceiptShipment').value='S';c.changeCustomerReturnReceiptShipment();element('customerReturnReceiptLot0').value='1';element('customerReturnReceiptDate').value='2026-10-21';element('customerReturnReceiptReason').value='訂錯貨';element('customerReturnReceiptSaleable').checked=true;};
 return {c,order,storage,element,calls,alerts,prepare,setRead:f=>read=f,setSend:f=>send=f,setPending:v=>pending=v,setRefreshFailure:v=>failRefresh=v};
}
test('receipt form requires explicit shipment batch quantities and saleable decision, then uses the shared transport once',async()=>{
 const f=fixture();await f.c.openCustomerReturnReceipt('O','Q');await f.c.saveCustomerReturnReceipt();assert.equal(f.calls.length,0);
 await f.prepare();f.element('customerReturnReceiptLot0').value='3';await f.c.saveCustomerReturnReceipt();assert.equal(f.calls.length,0);
 f.element('customerReturnReceiptLot0').value='1';await f.c.saveCustomerReturnReceipt();
 assert.equal(f.calls.length,1);assert.equal(f.calls[0].requestId,'Q');assert.equal(f.calls[0].shipmentId,'S');
 assert.deepEqual(f.calls[0].selections,[{lotId:'L',qty:1}]);assert.equal(f.calls[0].warehouseId,'A');assert.equal(f.calls[0].settlement,'CLOSE');
});
test('receipt form freezes unknown operation and double taps cannot start another transport',async()=>{
 const f=fixture();await f.prepare();let reject;f.setSend(()=>new Promise((_,r)=>{reject=r;}));
 const first=f.c.saveCustomerReturnReceipt();await f.c.saveCustomerReturnReceipt();assert.equal(f.calls.length,1);
 reject(Error('lost reply'));await first;assert.match(f.element('customerReturnReceiptStatus').textContent,/lost reply/);
 f.element('customerReturnReceiptReason').value='changed';f.setSend(async()=>({...f.order,id:'O'}));await f.c.saveCustomerReturnReceipt();
 assert.equal(f.calls.length,2);assert.deepEqual(f.calls[0],f.calls[1]);
});
test('pending receipt recovery survives disappearance from pending queue and corrupt cache remains visible without submit',async()=>{
 const f=fixture(),intent={orderId:'O',requestId:'Q',itemId:'I',shipmentId:'S',warehouseId:'A',date:'2026-10-21',reason:'訂錯貨',selections:[{lotId:'L',qty:1}]};
 f.storage.set('v2-return-receipt:U:O','opaque');f.setPending({intent});
 assert.match(f.c.customerReturnReceiptRecoveryHtml(),/確認前次退貨收貨結果/);
 await f.c.openCustomerReturnReceipt('O');assert.match(f.element('customerReturnReceiptBody').innerHTML,/原出貨/);assert.equal(f.calls.length,0);
 f.setPending(Error('corrupt checkpoint'));assert.match(f.c.customerReturnReceiptRecoveryHtml(),/corrupt checkpoint/);assert.equal(f.calls.length,0);
});
test('receipt view discards async reads and completion after session or view changes',async()=>{
 for(const mode of ['read','submit']){
  const f=fixture();let finish;
  if(mode==='read')f.setRead(()=>new Promise(r=>{finish=r;}));
  else{await f.prepare();f.setSend(()=>new Promise(r=>{finish=r;}));}
  const task=mode==='read'?f.c.openCustomerReturnReceipt('O','Q'):f.c.saveCustomerReturnReceipt();
  f.c.sessionDataGeneration++;f.c.resetCustomerReturnReceiptView();f.element('customerReturnReceiptStatus').textContent='new session';
  finish({...f.order,id:'O'});await task;assert.equal(f.element('customerReturnReceiptStatus').textContent,'new session');assert.deepEqual(f.alerts,[]);
 }
});
test('confirmed receipt refresh failure is displayed as committed and cannot submit again',async()=>{
 const f=fixture();await f.prepare();f.setRefreshFailure(true);await f.c.saveCustomerReturnReceipt();
 assert.match(f.element('customerReturnReceiptStatus').textContent,/已實收並入庫.*更新失敗/);assert.equal(f.element('customerReturnReceiptSave').disabled,true);
 // A programmatic call must obey the same confirmed state as the disabled button.
 await f.c.saveCustomerReturnReceipt();assert.equal(f.calls.length,1);
});
