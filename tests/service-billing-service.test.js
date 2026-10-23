'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {commitServiceOrderBilling:bill}=require('../functions/service-billing-service');
const {caseDocId,itemCaseIndexId}=require('../functions/service-case-service');
Object.assign(process.env,{ENABLE_SERVICE_CASE_EMULATOR:'true',GCLOUD_PROJECT:'demo-yushin',
 FIRESTORE_EMULATOR_HOST:'127.0.0.1:8080',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9099'});
function fixture(){
 const item={itemId:'S',productId:'P',productType:'Service',serviceKind:'ONSITE_REPAIR',qty:1};
 const docs=new Map([
  ['users/U',{role:'sales',active:true}],
  ['orders/O',{ownerUid:'U',status:'active',inventoryReservationStatus:'completed',items:[item]}],
  ['products/P',{productType:'Service',serviceKind:'ONSITE_REPAIR',active:true}],
  ['serviceCases/'+itemCaseIndexId('O','S'),{recordType:'ITEM_CASE_INDEX',orderId:'O',itemId:'S',productId:'P',kind:'ONSITE_REPAIR',caseIds:['C']}],
  ['serviceCases/'+caseDocId('O','S','C'),{orderId:'O',itemId:'S',productId:'P',caseId:'C',kind:'ONSITE_REPAIR',serviceQty:1,
   events:[{id:'done',type:'REPAIR_COMPLETED',actorUid:'E',occurredAt:'2026-10-23T08:00:00Z',workSummary:'修復電源'}]}]
 ]);
 let writes=0,failReceipt=false;const reads=[];
 const db={projectId:'demo-yushin',collection:name=>({doc:id=>({path:name+'/'+id})}),runTransaction:async callback=>{
  const pending=[];const tx={get:async ref=>{reads.push(ref.path);return {exists:docs.has(ref.path),data:()=>structuredClone(docs.get(ref.path))};},
   update:(ref,data)=>pending.push([ref.path,{...docs.get(ref.path),...structuredClone(data)}]),
   set:(ref,data)=>{if(failReceipt)throw Error('receipt failure');pending.push([ref.path,structuredClone(data)]);}};
  const result=await callback(tx);
  for(const [path,data] of pending){docs.set(path,data);writes++;}return result;
 }};
 return {db,docs,reads,count:()=>writes,fail:()=>{failReceipt=true;},order:()=>docs.get('orders/O'),
  record:()=>docs.get('serviceCases/'+caseDocId('O','S','C'))};
}
const input=(extra={})=>({orderId:'O',operationId:'billing-operation-001',expectedIsBilled:false,isBilled:true,billingDate:'2026-10-23',...extra});
test('pure service billing atomically records role audit, verified index and immutable retry receipt',async()=>{
 const f=fixture(),beforeItems=structuredClone(f.order().items);
 const first=await bill(f.db,'U',input());assert.equal(first.status,'committed');
 assert.equal(f.count(),2);assert.equal(f.order().isBilled,true);assert.deepEqual(f.order().workCategories,['complete']);
 assert.equal(f.order().statusHistory[0].by,'U');assert.deepEqual(f.order().items,beforeItems);
 assert.equal((await bill(f.db,'U',input())).status,'already-applied');assert.equal(f.count(),2);
 await assert.rejects(bill(f.db,'U',input({billingDate:'2026-10-24'})),/不同意圖/);
 const undo=input({operationId:'billing-operation-002',isBilled:false,billingDate:'',expectedIsBilled:true});
 assert.equal((await bill(f.db,'U',undo)).changed,true);assert.equal(f.order().isBilled,false);
 assert.deepEqual(f.order().workCategories,['billing']);assert.equal(f.order().statusHistory.length,2);
 assert.equal((await bill(f.db,'U',input())).status,'already-applied');assert.equal(f.order().isBilled,false);
 assert.equal(f.count(),4);assert.ok([...f.docs.keys()].every(k=>/^(orders|users|products|serviceCases)\//.test(k)));
});
test('partial, forged completion and broken index never authorize billing',async()=>{
 for(const change of [f=>{f.record().events=[];f.order().items[0].deliveredQty=1;f.order().isDelivered=true;},
  f=>{f.order().items[0].qty=2;},f=>{f.docs.delete('serviceCases/'+caseDocId('O','S','C'));},
  f=>{f.record().productId='OTHER';},f=>{f.order().items[0].reservedQty=1;}]){
  const f=fixture();change(f);await assert.rejects(bill(f.db,'U',input()));assert.equal(f.count(),0);
 }
});
test('mixed orders, cancelled orders, stale status, missing initialization and open commercial release reject',async()=>{
 for(const change of [f=>f.order().items.push({itemId:'G',qty:1,productType:'Goods',deliveredQty:1}),
  f=>{f.order().orderStatus='cancelled';},f=>{f.order().inventoryReservationStatus='pending';},
  f=>{f.order().isBilled=true;},f=>{f.order().commercialReleaseMode='ADVANCE_TO_CUSTOMER';}]){
  const f=fixture();change(f);await assert.rejects(bill(f.db,'U',input()));assert.equal(f.count(),0);
 }
});
test('role, live account and ownership are checked even before replay',async()=>{
 for(const role of ['warehouse','purchaser','unknown']){
  const f=fixture();f.docs.get('users/U').role=role;
  await assert.rejects(bill(f.db,'U',input()),/權限/);assert.equal(f.count(),0);
 }
 for(const change of [f=>{f.docs.get('users/U').disabled=true;},f=>{f.order().ownerUid='OTHER';},
  f=>{f.docs.get('users/U').role='engineer';}]){
  const f=fixture();await bill(f.db,'U',input());change(f);
  await assert.rejects(bill(f.db,'U',input()),/權限|自己|不同意圖/);assert.equal(f.count(),2);
 }
 const f=fixture();f.docs.get('users/U').role='engineer';assert.equal((await bill(f.db,'U',input())).status,'committed');
});
test('invalid intents and real-project gate fail before any transaction write',async()=>{
 for(const extra of [{isBilled:'true'},{billingDate:'2026-02-30'},{isBilled:false,billingDate:'2026-10-23'},
  {operationId:'short'},{expectedIsBilled:undefined},{completedQty:1},{actorUid:'U'}]){
  const f=fixture();await assert.rejects(bill(f.db,'U',input(extra)));assert.equal(f.count(),0);
 }
 const f=fixture();f.db.projectId='preview-20135';await assert.rejects(bill(f.db,'U',input()),/Emulator/);assert.equal(f.count(),0);
});
test('receipt write failure rolls back both order billing and work index',async()=>{
 const f=fixture();f.fail();await assert.rejects(bill(f.db,'U',input()),/receipt failure/);
 assert.equal(f.count(),0);assert.equal(f.order().isBilled,undefined);assert.equal(f.order().workCategories,undefined);
});

const dateInput=(extra={})=>input({operationId:'billing-date-operation-001',action:'CHANGE_DATE',
 expectedIsBilled:true,isBilled:true,expectedBillingDate:'2026-10-23',billingDate:'2026-10-24',...extra});
test('date edit uses the same atomic writer, preserves billing history and replays without overwriting a later date',async()=>{
 const f=fixture();await bill(f.db,'U',input());
 const history=structuredClone(f.order().statusHistory),items=structuredClone(f.order().items);
 const changed=await bill(f.db,'U',dateInput());
 assert.equal(changed.action,'CHANGE_DATE');assert.equal(changed.changed,true);
 assert.equal(f.order().billingDate,'2026-10-24');assert.equal(f.order().isBilled,true);
 assert.deepEqual(f.order().statusHistory,history);assert.deepEqual(f.order().items,items);
 assert.deepEqual(f.order().workCategories,['complete']);
 assert.equal(f.order().fieldEditHistory[0].before,'2026-10-23');
 assert.equal(f.order().fieldEditHistory[0].after,'2026-10-24');assert.equal(f.order().fieldEditHistory[0].by,'U');
 await bill(f.db,'U',dateInput({operationId:'billing-date-operation-002',expectedBillingDate:'2026-10-24',billingDate:'2026-10-25'}));
 assert.equal((await bill(f.db,'U',dateInput())).status,'already-applied');
 assert.equal(f.order().billingDate,'2026-10-25');assert.equal(f.order().fieldEditHistory.length,2);
 const count=f.count();
 await assert.rejects(bill(f.db,'U',dateInput({operationId:'billing-date-operation-003'})),/日期已變更/);
 await assert.rejects(bill(f.db,'U',dateInput({billingDate:'2026-10-26'})),/不同意圖/);
 assert.equal(f.count(),count);
});
test('date edit rejects malformed, unauthorized, unfinished, mixed and unbilled sources without writes',async()=>{
 for(const patch of [{action:'UNKNOWN'},{expectedBillingDate:'2026-02-30'},{expectedBillingDate:''},
  {expectedIsBilled:false},{isBilled:false,billingDate:''},{billingDate:'2026-02-30'}]){
  const f=fixture();await assert.rejects(bill(f.db,'U',dateInput(patch)));assert.equal(f.count(),0);
 }
 for(const change of [f=>{f.order().isBilled=false;},f=>{f.order().status='cancelled';},
  f=>{f.docs.get('users/U').role='warehouse';},f=>{f.docs.get('users/U').disabled=true;},
  f=>{f.order().ownerUid='OTHER';},f=>{f.record().events=[];},
  f=>{f.order().items.push({productType:'Goods',qty:1});}]){
  const f=fixture();Object.assign(f.order(),{isBilled:true,billingDate:'2026-10-23'});change(f);
  await assert.rejects(bill(f.db,'U',dateInput()));assert.equal(f.count(),0);
 }
});
test('date edit no-op records only a receipt and a failed receipt rolls back date, audit and index',async()=>{
 const f=fixture();Object.assign(f.order(),{isBilled:true,billingDate:'2026-10-23'});
 assert.equal((await bill(f.db,'U',dateInput({billingDate:'2026-10-23'}))).changed,false);
 assert.equal(f.count(),1);assert.equal(f.order().fieldEditHistory,undefined);
 const g=fixture();Object.assign(g.order(),{isBilled:true,billingDate:'2026-10-23',workCategories:['complete']});g.fail();
 await assert.rejects(bill(g.db,'U',dateInput()),/receipt failure/);
 assert.equal(g.count(),0);assert.equal(g.order().billingDate,'2026-10-23');
 assert.equal(g.order().fieldEditHistory,undefined);assert.deepEqual(g.order().workCategories,['complete']);
});
