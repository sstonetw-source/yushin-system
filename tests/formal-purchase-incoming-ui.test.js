'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('src/services/supply-order.js','utf8');
function fixture(){
 const calls=[],stocks=[],options={projectId:'demo-yushin'};
 const po={poNo:'PO1',status:'ORDERED',documentOnly:false,items:[{orderId:'O',itemId:'I'}],
  supplyOrderIds:['S1']};
 let transport=()=>({data:{status:'applied',poNo:'PO1',receiptId:'po-incoming-PO1',supplyOrderIds:['S1']}});
 const functions={app:{options},useEmulator:(host,port)=>{assert.equal(host,'127.0.0.1');assert.equal(port,5001);},
  httpsCallable:name=>async req=>{assert.equal(name,'registerV2FormalPurchaseIncoming');calls.push(structuredClone(req));return transport(req);}};
 const c=vm.createContext({YUSHIN_V2_PO_INCOMING_EMULATOR:true,YUSHIN_FORMAL_PURCHASE_EMULATOR:true,
  APP_ENVIRONMENT:'emulator',location:{hostname:'localhost'},currentUser:{uid:'BUY'},currentUserRole:'purchaser',
  canCreatePurchaseOrderCapability:()=>true,canAccessPage:()=>true,
  formalPurchaseBackendPilotEnabled:()=>true,ensureFormalPurchaseFunctionsCompat:async()=>{},
  firebase:{app:()=>({options,functions:()=>functions}),auth:()=>({app:{options},currentUser:{uid:'BUY'},emulatorConfig:{host:'localhost',port:9099}})},
  db:{app:{options},collection:name=>({doc:id=>({get:async()=>({exists:true,data:()=>({purchaseDocumentId:'PO1',
   productKey:'P',warehouseId:'A',qty:3,receivedQty:0,incomingRegisteredQty:3,fulfillmentType:'WAREHOUSE'})})})})},
  runRoleTransaction:()=>{throw Error('legacy writer must not run');}});
 vm.runInContext(source,c);
 return {c,po,calls,stocks,setTransport:fn=>transport=fn};
}
test('isolated PO incoming UI submits fixed PO number through callable and re-reads supply proof',async()=>{
 const x=fixture();await x.c.registerPurchaseIncoming('PO1',x.po,{actorUid:'BUY',actorRole:'purchaser',
  onStockCommitted:(p,w)=>x.stocks.push([p,w])});
 assert.deepEqual(x.calls,[{poNo:'PO1'}]);assert.deepEqual(x.stocks,[['P','A']]);
});
test('backend error and lost response never fall back to legacy and always reuse immutable PO identifier',async()=>{
 const x=fixture();x.setTransport(()=>{throw Error('lost response');});
 await assert.rejects(x.c.registerPurchaseIncoming('PO1',x.po,{actorUid:'BUY',actorRole:'purchaser'}),/lost response/);
 x.setTransport(()=>({data:{status:'already-applied',poNo:'PO1',receiptId:'po-incoming-PO1',supplyOrderIds:['S1']}}));
 await x.c.registerPurchaseIncoming('PO1',x.po,{actorUid:'BUY',actorRole:'purchaser'});
 assert.deepEqual(x.calls,[{poNo:'PO1'},{poNo:'PO1'}]);
});
test('PO incoming refuses foreign host/project, role mutation and invalid receipt before any legacy writer',async()=>{
 for(const mode of ['host','project','role','reply']){
  const x=fixture();
  if(mode==='host')x.c.location.hostname='yu-shing-company.web.app';
  if(mode==='project')x.c.db.app.options.projectId='yu-shing-company';
  if(mode==='role')x.c.currentUserRole='sales';
  if(mode==='reply')x.setTransport(()=>({data:{status:'applied',poNo:'PO1',receiptId:'forged',supplyOrderIds:['S1']}}));
  await assert.rejects(x.c.registerPurchaseIncoming('PO1',x.po,{actorUid:'BUY',actorRole:'purchaser'}));
  if(mode!=='reply')assert.equal(x.calls.length,0);
 }
});
