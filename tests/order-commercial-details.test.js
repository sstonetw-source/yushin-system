const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const core=require('../modules/order-commercial-details');
test('first receipt locks an order even when only its last item arrived or receipt quantities were reversed',()=>{
 assert.equal(core.beforeReceipt({items:[{qty:3,receivedQty:0}]}),true);
 for(const patch of [{receivedQty:1},{receiptEvents:[{qty:1}]},{warehouseShippedQty:1},{deliveredQty:1}]){
  const items=Array.from({length:30},()=>({qty:3}));Object.assign(items[29],patch);assert.equal(core.beforeReceipt({items}),false);
 }
 for(const patch of [{isArrived:true},{isDelivered:true},{isBilled:true},{deliveryRecords:[{}]}])assert.equal(core.beforeReceipt(patch),false);
 assert.equal(core.itemMoved({transferPendingId:'T'}),true);assert.equal(core.beforeReceipt({items:[{transferPendingId:'T'}]}),true);
});
test('amounts show unit price times quantity per item without mutating source totals',()=>{
 const items=[{itemName:'A',unitPrice:11300,qty:30},{itemName:'B',unitPrice:0.1,qty:3}];
 assert.deepEqual(core.amountLines(items),[{name:'A',unit:11300,qty:30,total:339000},{name:'B',unit:0.1,qty:3,total:0.3}]);assert.equal(items[0].totalPrice,undefined);
});
function fixture(){
 const stored={ownerUid:'U',remarks:'old',transactionType:'借',items:[{qty:2,receivedQty:0}],status:'active'},cached={id:'O',...structuredClone(stored)};
 const writes=[],alerts=[],messages=[],state={wait:null,reads:0,lost:false};
 const c=vm.createContext({window:{},currentUser:{uid:'U'},currentUserRole:'sales',currentUserName:'Owner',canEditPage:()=>true,ordersCache:[cached],
  YushinOrderCommercialDetails:core,renderOrdersList(){},alert:x=>alerts.push(x),showActionFeedback:x=>messages.push(x),productOperationErrorMessage:(a,e)=>a+e.message,
  firebase:{firestore:{FieldValue:{arrayUnion:x=>x}}},db:{collection:()=>({doc:()=>({})})},runRoleTransaction:async callback=>{
   const result=await callback({get:async()=>{state.reads++;if(state.wait)await state.wait;return {exists:true,data:()=>structuredClone(stored)};},update:(r,patch)=>{writes.push(patch);Object.assign(stored,{...patch,fieldEditHistory:[...(stored.fieldEditHistory||[]),patch.fieldEditHistory]});}});if(state.lost){state.lost=false;throw Error('連線中斷，回覆不確定');}return result;}});
 // Load the actual browser predicates so role globals resolve inside the fixture context.
 vm.runInContext(fs.readFileSync('modules/order-commercial-details.js','utf8'),c);
 const source=fs.readFileSync('src/features/orders/delivery-actions.js','utf8');vm.runInContext(source.slice(source.indexOf('window.orderCommercialEditPending='),source.indexOf('window.updateOrderField =')),c);
 return {c,stored,cached,writes,alerts,messages,state};
}
test('metadata commit waits for backend success, rejects duplicate submission and resumes an already saved value',async()=>{
 const x=fixture();let finish;x.state.wait=new Promise(r=>finish=r);const pending=x.c.updateOrderCommercialField('O','remarks','new');
 assert.equal(x.cached.remarks,'old');await x.c.updateOrderCommercialField('O','remarks','new');finish();await pending;
 assert.equal(x.writes.length,1);assert.equal(x.cached.remarks,'new');assert.equal(x.messages.length,1);
 x.cached.remarks='old';await x.c.updateOrderCommercialField('O','remarks','new');assert.equal(x.writes.length,1);
});
test('receipt and concurrent user edits found in the transaction reject stale form writes',async()=>{
 for(const mutate of [x=>x.stored.items[0].receivedQty=1,x=>x.stored.remarks='other']){
  const x=fixture();mutate(x);await x.c.updateOrderCommercialField('O','remarks','new');assert.equal(x.writes.length,0);assert.equal(x.cached.remarks,x.stored.remarks);assert.equal(x.alerts.length,1);
 }
});
test('role and ownership restrictions remain enforced and empty trade choices cannot be saved',async()=>{
 for(const [role,owner,allowed] of [['sales','U',true],['engineer','U',true],['sales','OTHER',false],['purchaser','U',false],['warehouse','U',false],['admin','OTHER',true]]){
  const x=fixture();x.c.currentUserRole=role;x.stored.ownerUid=owner;x.cached.ownerUid=owner;
  await x.c.updateOrderCommercialField('O','remarks','new');assert.equal(x.writes.length,allowed?1:0);
 }
 const x=fixture();await x.c.updateOrderCommercialField('O','transactionType','');assert.equal(x.writes.length,0);
});

test('lost save response is recovered by reading the committed value without another history entry',async()=>{
 const x=fixture();x.state.lost=true;await x.c.updateOrderCommercialField('O','remarks','new');
 assert.equal(x.cached.remarks,'old');assert.equal(x.stored.remarks,'new');assert.equal(x.writes.length,1);
 await x.c.updateOrderCommercialField('O','remarks','new');assert.equal(x.cached.remarks,'new');assert.equal(x.writes.length,1);
});
