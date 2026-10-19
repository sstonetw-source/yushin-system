'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const service=fs.readFileSync('src/services/customer-return.js','utf8'),feature=fs.readFileSync('modules/customer-cancellations.js','utf8');
test('physical return writers have one Service owner and both existing UI actions delegate to it',()=>{
 assert.doesNotMatch(service,/\b(document|window|sessionStorage|alert|prompt|confirm)\b\s*[.(]/);
 for(const name of ['commitCustomerReturnRequest','commitCustomerReturnWithdrawal','commitCancelledPurchaseKeepStock','postCustomerReturnStock','assertActiveReturnWarehouse','commitCustomerReturnReceipt','commitCustomerReturnHoldRelease']){
  assert.equal((service.match(new RegExp('async function '+name+'\\(','g'))||[]).length,1);
  assert.doesNotMatch(feature,new RegExp('async function '+name+'\\('));
 }
 assert.match(feature,/await commitCustomerReturnReceipt\(/);assert.match(feature,/await commitCustomerReturnHoldRelease\(id\)/);
 assert.match(feature,/await commitCustomerReturnRequest\(/);assert.match(feature,/await commitCustomerReturnWithdrawal\(/);assert.match(feature,/await commitCancelledPurchaseKeepStock\(/);
 assert.doesNotMatch(feature,/runRoleTransaction|tx\.(set|update|create|delete)\(/);
 const release=feature.slice(feature.indexOf('window.releaseCustomerReturnHold='),feature.indexOf('window.editReturnRecord='));
 assert.doesNotMatch(release,/runRoleTransaction|tx\.(set|update)/);
 const manifest=fs.readFileSync('tools/build-app.cjs','utf8');assert.equal((manifest.match(/src\/services\/customer-return.js/g)||[]).length,1);
});
function fixture({fail=false,allowed=true}={}){
 const docs=new Map([['customerReturnReceipts/R',{orderId:'O',itemId:'I',qty:2,warehouseId:'A',disposition:'HOLD'}],
  ['orders/O',{items:[{itemId:'I',warehouseId:'A'}],returnRecords:[{id:'R'}],deliveryRecords:[]}],['warehouses/A',{active:true}]]);
 const c=vm.createContext({db:{collection:n=>({doc:id=>({path:n+'/'+id})})},canReceiveInventoryCapability:()=>allowed,
  currentUser:{uid:'receiver'},normalizedOrderItems:o=>o.items,savedReturnRecords:o=>o.returnRecords,savedDeliveryRecords:o=>o.deliveryRecords,
  deliveryActor:()=> 'receiver',
  applyInventoryReturnDeltaInTransaction:async(tx,order,qty)=>{assert.equal(order.returnRecords.length,0);tx.set({path:'posted/R'},{qty});},
  runRoleTransaction:async fn=>{const writes=[];await fn({get:async r=>({exists:docs.has(r.path),data:()=>structuredClone(docs.get(r.path))}),set:(r,d)=>writes.push([r.path,d]),update:(r,d)=>writes.push([r.path,{...docs.get(r.path),...d}])});
   if(fail)throw Error('late rollback');for(const [path,data] of writes)docs.set(path,data);}});
 vm.runInContext(service,c);return {c,docs};
}
test('hold release shares original return posting, commits receipt and posting together and safely replays',async()=>{
 const f=fixture();await f.c.commitCustomerReturnHoldRelease('R');await f.c.commitCustomerReturnHoldRelease('R');
 assert.equal(f.docs.get('posted/R').qty,2);assert.equal(f.docs.get('customerReturnReceipts/R').disposition,'STOCK');
 assert.equal(f.docs.get('orders/O').returnRecords.length,1);
});
test('late failure or missing receiving permission leaves the hold and stock posting unchanged',async()=>{
 for(const options of [{fail:true},{allowed:false}]){const f=fixture(options),before=structuredClone([...f.docs]);await assert.rejects(f.c.commitCustomerReturnHoldRelease('R'));assert.deepEqual([...f.docs],before);}
});
function requestFixture(){
 const docs=new Map([['orders/O',{ownerUid:'sales',items:[{itemId:'I',qty:5}],deliveryRecords:[{itemId:'I',qty:5}],returnRecords:[],returnRequests:[]}],
  ['supplyOrders/S',{orderId:'C',productKey:'P',qty:5,receivedQty:2,status:'PARTIAL_RECEIPT',fulfillmentType:'DIRECT_SHIP'}],
  ['orders/C',{status:'cancelled'}],['warehouses/A',{active:true}],['inventory/P',{incoming:4}],['warehouseStocks/A__P',{incoming:1}]]);
 const c=vm.createContext({currentUser:{uid:'sales'},currentUserRole:'sales',db:{collection:n=>({doc:id=>({path:n+'/'+id})})},
  canManageOrderLifecycleCapability:()=>['admin','sales','engineer'].includes(c.currentUserRole),canCreatePurchaseOrderCapability:()=>['admin','purchaser'].includes(c.currentUserRole),
  deliveryActor:()=>c.currentUser.uid,normalizedOrderItems:o=>o.items,savedDeliveryRecords:o=>o.deliveryRecords,savedReturnRecords:o=>o.returnRecords,
  normalizedOrderStatus:o=>o.status,isPurchaseTerminalStatus:s=>['CANCELLED','CLOSED','RECEIVED'].includes(s),warehouseStockDocId:(w,k)=>w+'__'+k,
  supplyOrdersCollection:()=>c.db.collection('supplyOrders'),
  runRoleTransaction:async fn=>{const writes=[];await fn({get:async r=>{const snap={exists:docs.has(r.path),data:()=>structuredClone(docs.get(r.path))};c.afterRead?.();return snap;},
   set:(r,d,o)=>writes.push([r.path,o?.merge?{...docs.get(r.path),...d}:d]),update:(r,d)=>writes.push([r.path,{...docs.get(r.path),...d}])});
   if(c.fail)throw Error('late rollback');for(const [p,d] of writes)docs.set(p,d);if(c.lose&&writes.length){c.lose=false;throw Error('reply lost');}}});
 const actions=fs.readFileSync('src/features/orders/delivery-actions.js','utf8');vm.runInContext(actions.slice(actions.indexOf('function returnItemDeliveredQty('),actions.indexOf('function populateReturnItemOptions('))+service,c);
 return {c,docs,request:patch=>c.commitCustomerReturnRequest({orderId:'O',itemId:'I',operationId:'Q',qty:2,date:'2026-10-19',reason:'訂錯商品',...patch})};
}
test('request Service reserves only return allowance without posting stock and accepts exactly the remaining delivered amount',async()=>{
 const f=requestFixture();await f.request();await f.request({operationId:'Q2',qty:3});const before=JSON.stringify([...f.docs]);
 await assert.rejects(f.request({operationId:'excess',qty:1}),/最多可申請 0/);assert.equal(JSON.stringify([...f.docs]),before);
 assert.equal(f.docs.get('inventory/P').incoming,4);assert.equal(f.docs.get('orders/O').returnRecords.length,0);assert.equal(f.docs.get('orders/O').returnedQty,undefined);
 for(const patch of [{qty:0},{qty:NaN},{date:'2026-02-30'},{itemId:'missing'},{operationId:'bad/id'}])await assert.rejects(f.request(patch));
});
test('request replay binds original item quantity date reason and actor even after withdrawal',async()=>{
 const f=requestFixture();await f.request();await f.c.commitCustomerReturnWithdrawal({orderId:'O',requestId:'Q'});const before=JSON.stringify([...f.docs]);
 await f.request();assert.equal(JSON.stringify([...f.docs]),before);
 for(const patch of [{qty:1},{date:'2026-10-20'},{reason:'不同內容'},{itemId:'other'}])await assert.rejects(f.request(patch),/識別碼/);
 f.c.currentUser={uid:'other'};await assert.rejects(f.request(),/識別碼/);assert.equal(JSON.stringify([...f.docs]),before);
});
test('withdrawal keeps received quantities and records intact and retries do not rewrite audit timestamps',async()=>{
 const f=requestFixture();await f.request();await f.request({operationId:'Q2',qty:1});const o=f.docs.get('orders/O');o.returnRequests[0].receivedQty=1;o.returnRecords=[{id:'R',qty:1,settlement:'CLOSE'}];o.returnedQty=1;
 await f.c.commitCustomerReturnWithdrawal({orderId:'O',requestId:'Q'});const cancelled=f.docs.get('orders/O');assert.equal(cancelled.returnPending,true);assert.equal(cancelled.returnRequests[0].receivedQty,1);assert.equal(cancelled.returnRecords[0].id,'R');
 const before=JSON.stringify([...f.docs]);await f.c.commitCustomerReturnWithdrawal({orderId:'O',requestId:'Q'});assert.equal(JSON.stringify([...f.docs]),before);
 await assert.rejects(f.c.commitCustomerReturnWithdrawal({orderId:'O',requestId:'missing'}),/找不到退貨申請/);
});
test('thirty-request bound permits matching replay but refuses a new request without any mutation',async()=>{
 const f=requestFixture();await f.request();const o=f.docs.get('orders/O');for(let n=1;n<30;n++)o.returnRequests.push({id:'old'+n,status:'CANCELLED',itemId:'I',qty:1});
 await f.request();const before=JSON.stringify([...f.docs]);await assert.rejects(f.request({operationId:'over'}),/30/);assert.equal(JSON.stringify([...f.docs]),before);
});
test('request withdrawal and KEEP_STOCK abort account or role changes during reads without partial writes',async()=>{
 for(const action of ['request','withdraw','keep'])for(const change of ['account','role']){
  const f=requestFixture();if(action==='withdraw')await f.request();if(action==='keep')f.c.currentUserRole='purchaser';
  const before=JSON.stringify([...f.docs]);f.c.afterRead=()=>{if(change==='account')f.c.currentUser={uid:'other'};else f.c.currentUserRole='admin';};
  const run=action==='request'?()=>f.request():action==='withdraw'?()=>f.c.commitCustomerReturnWithdrawal({orderId:'O',requestId:'Q'}):()=>f.c.commitCancelledPurchaseKeepStock({supplyId:'S',warehouseId:'A',expectedDirect:true});
  await assert.rejects(run(),/帳號或權限已變更/);assert.equal(JSON.stringify([...f.docs]),before,action+' '+change);
 }
});
test('the three extracted writers preserve atomic rollback and uncertain request replies keep one original operation',async()=>{
 for(const action of ['request','withdraw','keep']){const f=requestFixture();if(action==='withdraw')await f.request();if(action==='keep')f.c.currentUserRole='purchaser';const before=JSON.stringify([...f.docs]);f.c.fail=true;
  const run=action==='request'?()=>f.request():action==='withdraw'?()=>f.c.commitCustomerReturnWithdrawal({orderId:'O',requestId:'Q'}):()=>f.c.commitCancelledPurchaseKeepStock({supplyId:'S',warehouseId:'A',expectedDirect:true});
  await assert.rejects(run(),/rollback/);assert.equal(JSON.stringify([...f.docs]),before,action);}
 const f=requestFixture();f.c.lose=true;await assert.rejects(f.request(),/reply lost/);const before=JSON.stringify([...f.docs]);await f.request();assert.equal(JSON.stringify([...f.docs]),before);
});
