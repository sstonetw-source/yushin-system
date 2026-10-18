'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const service=fs.readFileSync('src/services/customer-return.js','utf8'),feature=fs.readFileSync('modules/customer-cancellations.js','utf8');
test('physical return writers have one Service owner and both existing UI actions delegate to it',()=>{
 assert.doesNotMatch(service,/\b(document|window|sessionStorage|alert|prompt|confirm)\b\s*[.(]/);
 for(const name of ['postCustomerReturnStock','assertActiveReturnWarehouse','commitCustomerReturnReceipt','commitCustomerReturnHoldRelease']){
  assert.equal((service.match(new RegExp('async function '+name+'\\(','g'))||[]).length,1);
  assert.doesNotMatch(feature,new RegExp('async function '+name+'\\('));
 }
 assert.match(feature,/await commitCustomerReturnReceipt\(/);assert.match(feature,/await commitCustomerReturnHoldRelease\(id\)/);
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
