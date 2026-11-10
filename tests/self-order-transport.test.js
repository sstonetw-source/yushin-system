'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const source=fs.readFileSync('src/services/self-order-supply.js','utf8');
function setup({flag=true,failOnce=false}={}){
 const store=new Map(),calls=[];
 const supplyId='self-O-I',demandId='SALES_ORDER:O:I';
 const docs={
  'orders/O':{items:[{itemId:'I',selfOrderNos:['SO-TEST'],orderEvents:[{id:'self-so-fakeid000001',qty:2}]}]},
  ['receivingSupplyOrders/'+supplyId]:{demandId,qty:2,internalNo:'SO-TEST'},
  ['procurementDemands/'+encodeURIComponent(demandId)]:{demandId}
 };
 const functions={app:{options:{projectId:'yu-shing-company'}},httpsCallable(name){
  assert.equal(name,'commitV2SelfOrder');
  return async data=>{
   calls.push(data);
   if(failOnce&&calls.length===1)throw Error('lost response');
   return {data:{status:calls.length===1?'committed':'already-applied',operationId:data.operationId,
    supplyId,demandId,committedQty:data.qty}};
  };
 }};
 const app={options:{projectId:'yu-shing-company'},functions:()=>functions};
 const firebase={app:()=>app,auth:()=>({app,emulatorConfig:null,currentUser:{uid:'seller'}})};
 firebase.auth.currentUser={uid:'seller'};
 firebase.auth.app=app;
 const db={app,collection(name){return {doc(id){return {
  id:id||'fakeid000001',async get(){return {exists:true,data:()=>docs[name+'/'+id]};}
 };}};}};
 const context={APP_ENVIRONMENT:'production',YUSHIN_PRODUCTION_SELF_ORDER:flag,
  location:{hostname:'sstonetw-source.github.io',origin:'https://sstonetw-source.github.io',pathname:'/yushin-system/'},
  firebase,db,currentUser:{uid:'seller'},currentUserRole:'sales',
  sessionStorage:{getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)},
  ensureFormalPurchaseFunctionsCompat:async()=>{},
  YushinProcurementDemand:{demandIdForSource:()=>demandId},console};
 context.globalThis=context;
 vm.createContext(context);vm.runInContext(source,context);
 const details={supplier:'Vendor',qty:2,unitCost:0,orderDate:'2026-11-10',notes:'Test',actorUid:'seller',actorRole:'sales'};
 return {context,store,calls,details};
}

test('production manual self-order retries original checkpoint after lost response, without browser writer',async()=>{
 const f=setup({failOnce:true});
 await assert.rejects(f.context.commitSelfOrderBackend('O','I',f.details),/lost response/);
 assert.equal(f.calls[0].operationId,'so-fakeid000001');
 assert.equal(f.store.size,1,'retain original operation after missing reply');
 const result=await f.context.commitSelfOrderBackend('O','I',f.details);
 assert.equal(result.internalNo,'SO-TEST');
 assert.equal(f.calls[1].operationId,f.calls[0].operationId);
 assert.equal(f.store.size,0,'clear only after verified server read');
});
test('production self-order is default closed and pending attempts never fallback to old writer',async()=>{
 const f=setup({flag:false});
 await assert.rejects(f.context.commitSelfOrderSupply('O','I',f.details),/尚未啟用/);
 assert.equal(f.calls.length,0);
 f.store.set('self-order-pending:seller:O:I','{"version":1,"fingerprint":"bad","operationId":"so-previous"}');
 await assert.rejects(f.context.commitSelfOrderSupply('O','I',f.details),/尚未啟用/);
 assert.equal(f.store.size,1);
});
test('changed contents with an unknown prior outcome refuse a second commitment',async()=>{
 const f=setup({failOnce:true});
 await assert.rejects(f.context.commitSelfOrderBackend('O','I',f.details),/lost response/);
 await assert.rejects(f.context.commitSelfOrderBackend('O','I',{...f.details,qty:3}),/尚待核對/);
 assert.equal(f.calls.length,1);
});
