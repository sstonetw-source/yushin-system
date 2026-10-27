'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {receiptIntent}=require('../functions/supply-receipt-service');
test('receipt backend accepts only exact receipt identity and finite integer quantities, dates and batch text',()=>{
 const input={supplyId:'SUP',operationId:'receipt_1',qty:2,lotNo:'LOT',expiryDate:'2028-01-01'};
 assert.deepEqual(receiptIntent(input),input);
 for(const patch of [{actorUid:'admin'},{role:'admin'},{qty:0},{qty:1.5},{qty:Infinity},{qty:'2'},{expiryDate:'2026-02-30'},{expiryDate:null},{lotNo:'bad\nlot'},{operationId:'bad/id'}])assert.throws(()=>receiptIntent({...input,...patch}),{code:'invalid-argument'});
});
function transport(){
 const input={supplyId:'SUP',operationId:'receipt_1-0',qty:2,lotNo:'LOT',expiryDate:'2028-01-01'},calls=[];
 const options={projectId:'demo-yushin'},auth={app:{options},emulatorConfig:{host:'127.0.0.1',port:9099},currentUser:{uid:'buyer'}};
 const proof={supplyOrderId:'SUP',qty:2,lotNo:'LOT',expiryDate:'2028-01-01',createdByUid:'buyer',createdByRole:'purchaser',reservationLocationSchemaVersion:2,productKey:'P',warehouseId:'W'};
 const functions={app:{options},useEmulator:(host,port)=>calls.push({host,port}),httpsCallable:name=>async data=>{calls.push({name,data});return {data:{status:'confirmed',supplyId:data.supplyId,operationId:data.operationId,affectedOrderIds:['O']}};}};
 const jobs=[{ownerUid:'buyer',actorRole:'purchaser',supplyId:'SUP',operationBase:'receipt_1',entries:[{itemIndex:0,qty:2,lotNo:'LOT',expiryDate:'2028-01-01'}]}];
 const c=vm.createContext({APP_ENVIRONMENT:'emulator',YUSHIN_V2_RECEIVING_EMULATOR:true,location:{hostname:'localhost'},currentUser:{uid:'buyer'},currentUserRole:'purchaser',canReceiveInventoryCapability:()=>true,
  firebase:{auth:()=>auth,functions:()=>functions,app:()=>({options,functions:()=>functions})},sessionStorage:{getItem:()=>JSON.stringify(jobs)},
  db:{app:{options},collection:()=>({doc:()=>({get:async()=>({exists:true,data:()=>proof})})})}});
 vm.runInContext(fs.readFileSync('src/services/receiving-transport.js','utf8'),c);
 const receive=()=>c.receiveV2SupplyEmulator(input.supplyId,input.qty,input.lotNo,input.expiryDate,input.operationId,{actorUid:'buyer',actorRole:'purchaser'});
 return {c,input,calls,auth,proof,functions,jobs,receive};
}
test('receipt transport sends no actor, requires saved original intent and verifies real receipt proof',async()=>{
 const x=transport();assert.deepEqual([...await x.receive()],['O']);const call=x.calls.find(row=>row.name);assert.equal(call.name,'receiveV2Supply');assert.equal(call.data.actorUid,undefined);assert.equal(call.data.actorRole,undefined);
 for(const mutate of [x=>x.jobs[0].entries[0].qty=3,x=>x.c.sessionStorage.getItem=()=>null,x=>x.auth.currentUser.uid='other',x=>x.c.APP_ENVIRONMENT='production',x=>x.auth.app.options.projectId='production']){
  const y=transport();mutate(y);await assert.rejects(y.receive());assert.equal(y.calls.some(row=>row.name),false);
 }
 const bad=transport();bad.proof.qty=3;await assert.rejects(bad.receive(),/憑證/);
});
test('receipt transport leaves original work on unknown replies and account changes, never runs another writer',async()=>{
 for(const switched of [true,false]){
  const x=transport(),original=JSON.stringify(x.jobs);x.functions.httpsCallable=()=>async()=>{
   if(switched)x.auth.currentUser.uid='other';else throw Error('lost reply');
   return {data:{status:'confirmed',supplyId:'SUP',operationId:'receipt_1-0',affectedOrderIds:['O']}};
  };
  await assert.rejects(x.receive());assert.equal(JSON.stringify(x.jobs),original);
 }
});
function directTransport(){
 const x=transport();
 x.c.currentUserRole='sales';x.c.canReceiveInventoryCapability=()=>false;
 x.input.lotNo='';x.input.expiryDate='';
 Object.assign(x.jobs[0],{actorRole:'sales'});
 Object.assign(x.jobs[0].entries[0],{lotNo:'',expiryDate:''});
 Object.assign(x.proof,{createdByRole:'sales',fulfillmentType:'DIRECT_SHIP',warehouseId:''});
 delete x.proof.lotNo;delete x.proof.expiryDate;delete x.proof.reservationLocationSchemaVersion;
 x.receive=onStockCommitted=>x.c.receiveV2SupplyEmulator(x.input.supplyId,x.input.qty,x.input.lotNo,x.input.expiryDate,x.input.operationId,{actorUid:'buyer',actorRole:'sales',onStockCommitted});
 return x;
}
test('direct receipt transport confirms the actual lot-free Core snapshot without invalidating stock',async()=>{
 const x=directTransport();let notifications=0;
 assert.deepEqual([...await x.receive(()=>notifications++)],['O']);
 assert.equal(notifications,0);
 Object.assign(x.proof,{lotNo:'',expiryDate:''});
 assert.deepEqual([...await x.receive(()=>notifications++)],['O']);
 assert.equal(notifications,0);
});
test('direct receipt proof still rejects wrong identity, quantities and any warehouse batch data, retaining original work',async()=>{
 for(const patch of [{supplyOrderId:'OTHER'},{qty:3},{createdByUid:'other'},{createdByRole:'admin'},
  {lotNo:'LOT'},{expiryDate:'2028-01-01'},{warehouseId:'W'},{lotNo:null},{expiryDate:0},{fulfillmentType:'WAREHOUSE'}]){
  const x=directTransport(),original=JSON.stringify(x.jobs);Object.assign(x.proof,patch);
  await assert.rejects(x.receive(),/憑證/);assert.equal(JSON.stringify(x.jobs),original);
 }
 const warehouse=transport();delete warehouse.proof.lotNo;
 await assert.rejects(warehouse.receive(),/憑證/);
});
test('generated server receipt runtime stays identical to src and is not a runtime VM or second writer',()=>{
 require('node:child_process').execFileSync(process.execPath,['tools/build-receiving-runtime.cjs','--check']);
 const source=fs.readFileSync('functions/supply-receipt-service.js','utf8');assert.doesNotMatch(source,/node:vm|new Function|\.update\([^\n]*(receivedQty|onHand|reserved)/);
 const exported=fs.readFileSync('functions/index.js','utf8');
 assert.match(exported,/exports\.receiveV2Supply=createSupplyReceiptCallable/);
 assert.match(fs.readFileSync('functions/supply-receipt-callable.js','utf8'),/receiptBackendProject/);
});
test('generated receiving Service resolves its terminal PO dependency before any database write',async()=>{
 const create=require('../functions/shared/receiving-runtime'),supply={type:'PURCHASING_PO',qty:4,receivedQty:0,status:'CANCELLED',fulfillmentType:'WAREHOUSE',productKey:'P',warehouseId:'W'};
 let writes=0;
 const db={projectId:'demo-yushin',collection:name=>({doc:(id='unused')=>({path:name+'/'+id,id})})};
 const c={db,currentUser:{uid:'buyer'},currentUserRole:'purchaser',runRoleTransaction:fn=>fn({get:async ref=>({exists:ref.path==='supplyOrders/S',data:()=>supply}),set:()=>writes++,update:()=>writes++}),
  cores:{YushinSupply:require('../modules/supply-core'),YushinReceiving:require('../modules/receiving-core'),YushinProcurementDemand:require('../modules/procurement-demand-core')},
  canConfirmSupplyReceipt:()=>true,deliveryActor:()=> 'buyer',localDateString:()=> '2026-10-20'};
 await assert.rejects(create(c).receiveSupplyOrderRecord('S',2,'LOT','2028-01-01','receipt_test'),error=>!(error instanceof ReferenceError)&&/取消/.test(error.message));
 assert.equal(writes,0);
});

test('legacy browser receipt keeps five-line default while the generated server explicitly opts into fifteen',async()=>{
 const c=vm.createContext({});vm.runInContext(fs.readFileSync('src/services/receiving.js','utf8'),c);
 c.assertV2ReceiptActor=async()=>{};c.normalizedOrderStatus=()=> 'normal';
 const input={supply:{orderId:'O',itemId:'I',productKey:'P',warehouseId:'W'},item:{},
  order:{items:Array.from({length:15},(_,i)=>({itemId:i?'I'+i:'I'})),ownerUid:'U',salesCode:'S',status:'active',orderStatus:'normal',inventoryReservationStatus:'pending'}};
 await assert.rejects(c.validateV2ReceiptSource({},input),/1–5/);
 vm.runInContext('const RECEIVING_SOURCE_ITEM_LIMIT=15;',c);
 await assert.rejects(c.validateV2ReceiptSource({},input),/已完成初始化/);
 // Caller payload cannot change either cap; only the dependency-bound backend context opts in.
 assert.match(fs.readFileSync('functions/supply-receipt-service.js','utf8'),/receivingSourceItemLimit:15/);
});

function previewTransport(){
 const x=transport();x.c.APP_ENVIRONMENT='preview';x.c.YUSHIN_PREVIEW_RECEIVING=true;
 x.c.location.hostname='preview-20135.web.app';x.auth.app.options.projectId='preview-20135';
 delete x.auth.emulatorConfig;
 x.c.db.app={options:{projectId:'preview-20135'}};
 return x;
}
test('Preview receipt requires matching Auth, Functions, default app and actual Firestore binding before any RPC',async()=>{
 const good=previewTransport();assert.deepEqual([...await good.receive()],['O']);
 assert.equal(good.calls.some(call=>call.host),false);
 for(const change of [
  x=>x.c.db.app={options:{projectId:'demo-yushin'}},
  x=>delete x.c.db.app,
  x=>x.functions.app={options:{projectId:'yu-shing-company'}},
  x=>x.auth.emulatorConfig={host:'127.0.0.1',port:9099},
  x=>x.c.location.hostname='yu-shing-company.web.app',
  x=>x.c.YUSHIN_PREVIEW_RECEIVING=false
 ]){
  const x=previewTransport();change(x);await assert.rejects(x.receive());assert.equal(x.calls.length,0);
 }
 const demo=transport();demo.c.db.app={options:{projectId:'preview-20135'}};
 await assert.rejects(demo.receive());assert.equal(demo.calls.length,0);
});

test('shared PO receipt witness follows unique supply link and rejects draft, terminal, wrong source and fulfillment',async()=>{
 const create=require('../functions/shared/receiving-runtime');
 const supply={id:'SUP',productId:'P',qty:3,purchaseDocumentId:'PO',orderItemIndex:999};
 const expected={orderId:'O',itemId:'I',productId:'P',warehouseId:'',fulfillmentType:'DIRECT_SHIP'};
 const original={status:'ORDERED',supplyOrderIds:['OTHER','SUP'],items:[{}, {...expected,qty:3}]};
 let record=structuredClone(original),reads=0;
 const db={collection:()=>({doc:id=>({id})})},tx={get:async ref=>{assert.equal(ref.id,'PO');reads++;return {exists:true,data:()=>record};}};
 const runtime=create({db,cores:{}});
 await runtime.validateReceiptPurchaseDocument(tx,supply,expected);assert.equal(reads,1);
 for(const change of [
  r=>r.status='CANCELLED',r=>r.status='CLOSED',r=>r.status='DRAFT',r=>r.documentOnly=true,
  r=>r.supplyOrderIds=['SUP','SUP'],r=>r.supplyOrderIds=['OTHER'],
  r=>r.items[1].orderId='OTHER',r=>r.items[1].itemId='OTHER',r=>r.items[1].productId='OTHER',
  r=>r.items[1].qty=4,r=>r.items[1].warehouseId='W',r=>r.items[1].fulfillmentType='WAREHOUSE'
 ]){record=structuredClone(original);change(record);await assert.rejects(runtime.validateReceiptPurchaseDocument(tx,supply,expected),/採購單憑證/);}
 record=structuredClone(original);
 await assert.rejects(runtime.validateReceiptPurchaseDocument(tx,{...supply,productId:'OTHER'},expected),/採購單憑證/);
});
