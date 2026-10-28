const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');
const service=fs.readFileSync(path.join(__dirname,'../src/services/quick-purchase.js'),'utf8');
function setup({retry=false,changeAt='',fail=false}={}) {
    const order={items:[{itemId:'i',productId:'p',fulfillmentType:'DIRECT_SHIP',shortageQty:2,supplyOrderedQty:0}]};
    const records=new Map([['orders/o',order]]), writes=[];
    const ref=key=>({id:key.split('/').pop(),key});
    const c=vm.createContext({currentUser:{uid:'buyer'},currentUserRole:'purchaser',currentUserName:'Buyer',
        canCreatePurchaseOrderCapability:()=>true,canAccessPage:()=>true,
        db:{collection:name=>({doc:id=>ref(`${name}/${id}`)})},
        supplyOrdersCollection:()=>({doc:id=>ref(`supplyOrders/${id}`)}),quickPurchaseSupplyId:()=> 'manual-o-i',
        localDateString:()=> '2026-10-16',normalizedOrderStatus:()=> 'normal',normalizedOrderItems:o=>o.items.map(i=>({...i})),
        procurementDemandForOrderItem:(o,i)=>({demandId:'d',remainingToOrderQty:Math.max(0,i.shortageQty-i.supplyOrderedQty)}),
        procurementDemandRef:()=>ref('demands/d'),procurementDemandDocument:d=>d,
        YushinProcurementDemand:{applyOrder:(d,qty)=>({appliedQty:qty,demand:{...d,remainingToOrderQty:d.remainingToOrderQty-qty}})},
        YushinReceiving:require('../modules/receiving-core.js'),poIncomingKey:()=> 'p',
        brandIdentityForRecord:()=>({}),resolveBrandName:()=> '',brandIdForName:()=> '',orderWorkIndexFields:()=>({}),
        async runRoleTransaction(callback){
            for(let attempt=0;attempt<(retry?2:1);attempt++) {
                const pending=[];
                await callback({get:async r=>{
                    if(changeAt==='read')c.currentUser={uid:'other'};
                    return {exists:records.has(r.key),data:()=>structuredClone(records.get(r.key))};
                },set:(r,data)=>pending.push([r.key,data]),update:(r,data)=>pending.push([r.key,{...records.get(r.key),...data}])});
                if(retry&&attempt===0)continue;
                if(fail)throw new Error('commit failed');
                pending.forEach(([key,data])=>{records.set(key,structuredClone(data));writes.push(key);});
            }
        }
    });
    vm.runInContext(service,c);
    return {c,records,writes,details:{supplier:'Vendor',unitCost:0,expectedQty:2}};
}
test('quick service retries callback atomically and permits later genuine shortage',async()=>{
    const x=setup({retry:true});
    const result=await x.c.commitQuickPurchase('o','i',x.details);
    assert.equal(result.savedSupply.qty,2);
    assert.equal(x.records.get('supplyOrders/manual-o-i').orderEvents.length,1);
    assert.equal(result.savedSupply.unitCost,0);
    await x.c.commitQuickPurchase('o','i',x.details);
    assert.equal(x.records.get('supplyOrders/manual-o-i').qty,2);
    x.records.get('orders/o').items[0].shortageQty=4;
    await x.c.commitQuickPurchase('o','i',x.details);
    assert.equal(x.records.get('supplyOrders/manual-o-i').qty,4);
    assert.equal(x.records.get('supplyOrders/manual-o-i').orderEvents.length,2);
});
test('quick service rejects identity change during reads without any writes',async()=>{
    const x=setup({changeAt:'read'});
    await assert.rejects(x.c.commitQuickPurchase('o','i',x.details),/登入身份已變更/);
    assert.equal(x.writes.length,0);
});
test('quick service rejects original confirmation actor after account or role switch',async()=>{
    for(const role of ['purchaser','admin']) {
        const x=setup();x.c.currentUserRole=role;
        await assert.rejects(x.c.commitQuickPurchase('o','i',x.details,'previous','purchaser'),/登入身份已變更/);
        assert.equal(x.writes.length,0);
    }
    const x=setup();x.c.currentUserRole='admin';
    await assert.rejects(x.c.commitQuickPurchase('o','i',x.details,'buyer','purchaser'),/登入身份已變更/);
});
test('quick service failed commit leaves supply demand and order unchanged',async()=>{
    const x=setup({fail:true});
    await assert.rejects(x.c.commitQuickPurchase('o','i',x.details),/commit failed/);
    assert.equal(x.records.size,1);assert.equal(x.records.get('orders/o').items[0].supplyOrderedQty,0);
});
test('quick service validates cost quantity permissions and stale confirmation at boundary',async()=>{
    for(const patch of [{unitCost:-1},{unitCost:NaN},{expectedQty:NaN},{expectedQty:-1},{supplier:' '}]) {
        const x=setup();await assert.rejects(x.c.commitQuickPurchase('o','i',{...x.details,...patch}));assert.equal(x.writes.length,0);
    }
    const x=setup();await assert.rejects(x.c.commitQuickPurchase('o','i',{...x.details,expectedQty:3}),/待採購數量已變更/);
    x.c.canCreatePurchaseOrderCapability=()=>false;
    await assert.rejects(x.c.commitQuickPurchase('o','i',x.details),/無採購作業權限/);
});

test('quick purchase original Service routes demo-only pilot to Callable with stable unknown-reply checkpoint',async()=>{
 const x=setup(),records=x.records,calls=[],storage=new Map();
 const db={collection:name=>({doc:id=>({
  id:id||'12345678901234567890',
  get:async()=>({exists:records.has(name+'/'+id),data:()=>structuredClone(records.get(name+'/'+id))})
 })})};
 const opts={projectId:'demo-yushin'},auth={app:{options:opts},
  emulatorConfig:{host:'127.0.0.1',port:9099},currentUser:{uid:'buyer'}};
 let lose=true;
 const functions={app:{options:opts},useEmulator:()=>{},
  httpsCallable:name=>async request=>{
   assert.equal(name,'commitV2QuickPurchase');calls.push(request);
   const event={operationId:request.operationId,createdByUid:'buyer',
    qty:request.qty,supplier:request.supplier,unitCost:request.unitCost};
   records.set('supplyOrders/manual-o-i',{demandId:'d',productKey:'p',fulfillmentType:'DIRECT_SHIP',
    qty:2,orderEvents:[event]});
   const order=records.get('orders/o');
   records.set('orders/o',{...order,items:[{...order.items[0],supplyOrderedQty:2,
    orderEvents:[{id:'quick-'+request.operationId}]}]});
   records.set('procurementDemands/d',{demandId:'d',orderedQty:2});
   if(lose){lose=false;throw Error('response lost');}
   return {data:{status:'already-applied',operationId:request.operationId,
    supplyId:'manual-o-i',demandId:'d',committedQty:2}};
  }};
 x.c.APP_ENVIRONMENT='emulator';x.c.YUSHIN_QUICK_PURCHASE_EMULATOR=true;
 x.c.location={hostname:'localhost'};x.c.db={...db,app:{options:opts}};
 x.c.firebase={auth:()=>auth,functions:()=>functions,app:()=>({options:opts,functions:()=>functions})};
 x.c.ensureFormalPurchaseFunctionsCompat=async()=>{};
 x.c.sessionStorage={getItem:k=>storage.get(k)||null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
 x.c.YushinProcurementDemand.demandIdForSource=()=> 'd';
 await assert.rejects(x.c.commitQuickPurchase('o','i',x.details),/response lost/);
 assert.equal(storage.size,1);
 const retry=await x.c.commitQuickPurchase('o','i',x.details);
 assert.equal(retry.savedSupply.qty,2);
 assert.equal(retry.savedDemand.orderedQty,2);
 assert.equal(storage.size,0);
 assert.equal(calls.length,2);
 assert.equal(calls[0].operationId,calls[1].operationId);
 assert.equal(x.writes.length,0,'the legacy Client writer must not run');
});
test('quick purchase pilot flag never falls back outside local demo, or on corrupted checkpoint',async()=>{
 const x=setup();x.c.YUSHIN_QUICK_PURCHASE_EMULATOR=true;
 x.c.APP_ENVIRONMENT='production';
 await assert.rejects(x.c.commitQuickPurchase('o','i',x.details),/禁止改用舊交易/);
 assert.equal(x.writes.length,0);
 x.c.APP_ENVIRONMENT='emulator';x.c.location={hostname:'localhost'};
 const opts={projectId:'demo-yushin'};
 x.c.db={...x.c.db,app:{options:opts}};
 const auth={app:{options:opts},emulatorConfig:{host:'127.0.0.1',port:9099},currentUser:{uid:'buyer'}};
 x.c.firebase={auth:()=>auth,functions:()=>({}),app:()=>({options:opts})};
 x.c.sessionStorage={getItem:()=>'{corrupt checkpoint',setItem:()=>{},removeItem:()=>{}};
 await assert.rejects(x.c.commitQuickPurchase('o','i',x.details),/憑證無法讀取/);
 assert.equal(x.writes.length,0);
});
