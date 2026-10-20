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
 const c=vm.createContext({APP_ENVIRONMENT:'emulator',location:{hostname:'localhost'},currentUser:{uid:'buyer'},currentUserRole:'purchaser',canReceiveInventoryCapability:()=>true,
  firebase:{auth:()=>auth,functions:()=>functions,app:()=>({functions:()=>functions})},sessionStorage:{getItem:()=>JSON.stringify(jobs)},
  db:{collection:()=>({doc:()=>({get:async()=>({exists:true,data:()=>proof})})})}});
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
test('generated server receipt runtime stays identical to src and is not a runtime VM or second writer',()=>{
 require('node:child_process').execFileSync(process.execPath,['tools/build-receiving-runtime.cjs','--check']);
 const source=fs.readFileSync('functions/supply-receipt-service.js','utf8');assert.doesNotMatch(source,/node:vm|new Function|\.update\([^\n]*(receivedQty|onHand|reserved)/);
 assert.doesNotMatch(fs.readFileSync('functions/index.js','utf8'),/receiveV2Supply/);
});
